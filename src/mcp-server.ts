import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { randomUUID } from "crypto";
import * as vscode from "vscode";
import {
  clampWaitMs,
  createDiagnosticsTracker,
  resolveFileParam,
  snapshotForFile,
} from "./diagnosticsBridge";
import {
  attachIdeWebSocket,
  buildSelectionParams,
  type IdeMentionParams,
  type IdeSelectionParams,
} from "./ideWs";

export interface EditorContext {
  uri?: string;
  selection?: {
    start: { line: number; column: number };
    end: { line: number; column: number };
    text: string;
  };
}

export type EditorState = () => EditorContext;

export interface McpServerHandle {
  port: number;
  notifyContextChanged(): Promise<void>;
  /** v2-native file attach: IDE WebSocket `at_mentioned` (structured attachment in the TUI prompt draft). */
  mention(params: IdeMentionParams): void;
  sessionsClose(): Promise<void>;
  close(): Promise<void>;
}

export async function createMcpServer(
  editorState: EditorState,
  version: string,
  authToken: string,
): Promise<McpServerHandle> {
  type Session = {
    transport: StreamableHTTPServerTransport;
    server: McpServer;
  };

  const sessions = new Map<string, Session>();
  const tracker = createDiagnosticsTracker();

  // ─── Claude-IDE-compatible WebSocket bridge (selection_changed) ───
  // opencode's TUI discovers `ws://127.0.0.1:<port>` via `~/.claude/ide/*.lock`
  // (or OPENCODE_EDITOR_SSE_PORT) and expects 1-based coordinates.
  function toIdeSelection(ctx: EditorContext): IdeSelectionParams | undefined {
    if (!ctx.uri || !ctx.selection) return undefined;
    let filePath: string;
    try {
      const uri = vscode.Uri.parse(ctx.uri);
      if (uri.scheme !== "file") return undefined;
      filePath = uri.fsPath;
    } catch {
      return undefined;
    }
    return buildSelectionParams({
      filePath,
      startLine: ctx.selection.start.line,
      startCharacter: ctx.selection.start.column,
      endLine: ctx.selection.end.line,
      endCharacter: ctx.selection.end.column,
      text: ctx.selection.text,
    });
  }

  function createSessionServer(): McpServer {
    const mcp = new McpServer(
      { name: "opencode-tui-unofficial", version },
      { capabilities: { resources: { subscribe: true } } },
    );

    mcp.server.setRequestHandler(SubscribeRequestSchema, async () => ({}));
    mcp.server.setRequestHandler(UnsubscribeRequestSchema, async () => ({}));

    mcp.registerResource(
      "editorContext",
      "editor://context",
      {
        description: "Current editor state: active file path and text selection",
        mimeType: "application/json",
      },
      async (uri: URL) => ({
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify(editorState()),
          },
        ],
      }),
    );

    return mcp;
  }

  const httpServer = http.createServer(async (req, res) => {
    try {
      const authHeader = req.headers["authorization"] ?? "";
      const expected = `Bearer ${authToken}`;
      if (authHeader !== expected) {
        res.writeHead(401, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Unauthorized" }));
        return;
      }

      // ─── VS Code diagnostics bridge (same port + auth, no MCP overhead) ───
      const rawUrl = req.url ?? "/";
      const url = new URL(rawUrl, "http://127.0.0.1");
      const method = req.method?.toUpperCase();

      if (method === "GET" && url.pathname === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (method === "GET" && url.pathname === "/diagnostics") {
        const resolved = resolveFileParam(url.searchParams.get("file"), vscode.workspace.workspaceFolders);
        if ("error" in resolved) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: resolved.error }));
          return;
        }
        const waitMs = clampWaitMs(url.searchParams.get("waitMs"));
        const freshAfter = Number(url.searchParams.get("freshAfter")) || 0;
        const includeParam = url.searchParams.get("includeContent") ?? "";
        const includeContent = /^(1|true|yes)$/i.test(includeParam);
        let updatedAt = tracker.updatedAtFor(resolved.fsPath);
        if (freshAfter > 0 && waitMs > 0 && updatedAt <= freshAfter) {
          await tracker.waitForUpdate(resolved.fsPath, freshAfter, waitMs);
          updatedAt = tracker.updatedAtFor(resolved.fsPath);
        }
        const snap = snapshotForFile(resolved.fsPath, resolved.uri, {
          includeContent,
          updatedAt,
          freshAfter,
        });
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify(snap));
        return;
      }

      const sessionId = req.headers["mcp-session-id"] as string | undefined;

      if (method === "POST") {
        if (sessionId && sessions.has(sessionId)) {
          await sessions.get(sessionId)!.transport.handleRequest(req, res);
          return;
        }

        const mcp = createSessionServer();
        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => randomUUID(),
          onsessioninitialized: (id: string) => {
            sessions.set(id, { transport, server: mcp });
          },
        });

        transport.onerror = () => { /* SSE stream errors are expected on client disconnect */ };
        transport.onclose = () => {
          if (transport.sessionId) {
            sessions.delete(transport.sessionId);
          }
        };

        await mcp.connect(transport);
        await transport.handleRequest(req, res);
      } else if ((method === "GET" || method === "DELETE") && sessionId) {
        const session = sessions.get(sessionId);
        if (!session) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Unknown session ID" }));
          return;
        }
        await session.transport.handleRequest(req, res);
      } else {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Bad request" }));
      }
    } catch {
      if (!res.headersSent) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Internal server error" }));
      }
    }
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });

  const ide = attachIdeWebSocket({
    server: httpServer,
    authToken,
    version,
    getSelection: () => {
      try {
        return toIdeSelection(editorState());
      } catch {
        return undefined;
      }
    },
  });

  const address = httpServer.address();
  const port = address && typeof address === "object" ? address.port : 0;

  const cleanupInterval = setInterval(() => {
    for (const [id, session] of sessions) {
      const ref = session.transport.sessionId;
      if (!ref) {
        sessions.delete(id);
      }
    }
  }, 30000);

  return {
    port,
    async notifyContextChanged() {
      ide.broadcast();
      const promises: Promise<void>[] = [];
      for (const [id, session] of sessions) {
        promises.push(
          session.server.server.sendResourceUpdated({ uri: "editor://context" }).catch(() => {
            sessions.delete(id);
          }),
        );
      }
      await Promise.allSettled(promises);
    },
    mention(params: IdeMentionParams) {
      ide.mention(params);
    },
    async sessionsClose() {
      const promises: Promise<void>[] = [];
      for (const [, session] of sessions) {
        promises.push(session.server.server.close().catch(() => {}));
      }
      sessions.clear();
      await Promise.allSettled(promises);
    },
    async close() {
      clearInterval(cleanupInterval);
      tracker.dispose();
      ide.dispose();
      const promises: Promise<void>[] = [];
      for (const [, session] of sessions) {
        promises.push(session.server.close().catch(() => {}));
      }
      sessions.clear();
      await Promise.allSettled(promises);
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
