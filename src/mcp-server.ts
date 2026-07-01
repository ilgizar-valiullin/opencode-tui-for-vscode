import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SubscribeRequestSchema, UnsubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import http from "http";
import { randomUUID } from "crypto";

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
    const authHeader = req.headers["authorization"] ?? "";
    const expected = `Bearer ${authToken}`;
    if (authHeader !== expected) {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    const sessionId = req.headers["mcp-session-id"] as string | undefined;
    const method = req.method?.toUpperCase();

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
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => resolve());
    httpServer.once("error", reject);
  });

  const address = httpServer.address();
  const port = address && typeof address === "object" ? address.port : 0;

  return {
    port,
    async notifyContextChanged() {
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
    async close() {
      for (const [, session] of sessions) {
        await session.server.close().catch(() => {});
      }
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
      sessions.clear();
    },
  };
}
