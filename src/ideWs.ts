import type { IncomingMessage, Server as HttpServer } from "http";
import type { Duplex } from "stream";
import { WebSocketServer, type WebSocket } from "ws";

/**
 * Claude-IDE-compatible WebSocket bridge.
 *
 * opencode v2's TUI discovers the IDE by scanning
 * `~/.claude/ide/*.lock` (see `discoverEditorConnection` in opencode) and
 * opens `ws://127.0.0.1:<port>`. It then sends JSON-RPC `initialize` and
 * expects the IDE to push `selection_changed` notifications:
 *
 *   { "jsonrpc": "2.0", "method": "selection_changed",
 *     "params": { "filePath": "/abs/path",
 *                 "ranges": [{ "text": "...",
 *                              "selection": { "start": {"line":1,"character":1},
 *                                             "end": {"line":2,"character":5} } }] } }
 *
 * Lines and characters are 1-based (same convention as opencode's own Zed
 * integration). Auth uses the `x-claude-code-ide-authorization` header with
 * the token from the `.lock` file; connections without credentials are
 * accepted too (localhost only) because env-based discovery
 * (`OPENCODE_EDITOR_SSE_PORT`) carries no auth.
 */

export const IDE_PROTOCOL_VERSION = "2025-11-25";
export const IDE_SERVER_NAME = "opencode-tui-for-vscode";

export interface IdePosition {
  /** 1-based line number. */
  line: number;
  /** 1-based character offset within the line. */
  character: number;
}

export interface IdeSelectionRange {
  text: string;
  selection: { start: IdePosition; end: IdePosition };
}

export interface IdeSelectionParams {
  filePath: string;
  ranges: IdeSelectionRange[];
}

export interface IdeMentionParams {
  filePath: string;
  lineStart: number;
  lineEnd: number;
}

/**
 * Build `selection_changed` params from 0-based VS Code coordinates.
 * Collapsed cursors (empty text, start == end) are valid: opencode treats
 * them as "user opened the file".
 */
export function buildSelectionParams(args: {
  filePath: string;
  startLine: number;
  startCharacter: number;
  endLine: number;
  endCharacter: number;
  text: string;
}): IdeSelectionParams {
  return {
    filePath: args.filePath,
    ranges: [
      {
        text: args.text,
        selection: {
          start: { line: args.startLine + 1, character: args.startCharacter + 1 },
          end: { line: args.endLine + 1, character: args.endCharacter + 1 },
        },
      },
    ],
  };
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export interface IdeWebSocketHandle {
  /** Push the current selection (via `getSelection`) to all clients. */
  broadcast(): void;
  /** Send an `at_mentioned` file reference to all clients. */
  mention(params: IdeMentionParams): void;
  /** Number of currently connected clients. */
  socketCount(): number;
  dispose(): void;
}

export function attachIdeWebSocket(opts: {
  server: HttpServer;
  authToken: string;
  version: string;
  getSelection: () => IdeSelectionParams | undefined;
}): IdeWebSocketHandle {
  const { server, authToken, version, getSelection } = opts;
  const wss = new WebSocketServer({ noServer: true });
  const sockets = new Set<WebSocket>();

  function send(ws: WebSocket, payload: unknown): void {
    if (ws.readyState !== ws.OPEN) return;
    try {
      ws.send(JSON.stringify(payload));
    } catch {
      // Ignore send errors on half-closed sockets.
    }
  }

  function pushTo(ws: WebSocket): void {
    const selection = getSelection();
    if (!selection) return;
    send(ws, { jsonrpc: "2.0", method: "selection_changed", params: selection });
  }

  wss.on("connection", (ws: WebSocket) => {
    sockets.add(ws);
    ws.on("message", (data) => {
      let msg: { id?: unknown; method?: unknown };
      try {
        const parsed: unknown = JSON.parse(String(data));
        if (!parsed || typeof parsed !== "object") return;
        msg = parsed as { id?: unknown; method?: unknown };
      } catch {
        return;
      }
      if (
        msg.method === "initialize" &&
        (typeof msg.id === "number" || typeof msg.id === "string")
      ) {
        send(ws, {
          jsonrpc: "2.0",
          id: msg.id,
          result: {
            protocolVersion: IDE_PROTOCOL_VERSION,
            serverInfo: { name: IDE_SERVER_NAME, version },
          },
        });
        pushTo(ws);
      }
      // Everything else (e.g. `notifications/initialized`) needs no reply.
    });
    ws.on("close", () => {
      sockets.delete(ws);
    });
    ws.on("error", () => {
      sockets.delete(ws);
      try {
        ws.close();
      } catch {
        // Ignore.
      }
    });
  });

  function onUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const ideAuth = headerValue(req.headers["x-claude-code-ide-authorization"]);
    const bearer = headerValue(req.headers["authorization"]);
    const bearerToken =
      bearer && bearer.toLowerCase().startsWith("bearer ")
        ? bearer.slice("bearer ".length)
        : undefined;
    const badIdeAuth = ideAuth !== undefined && ideAuth !== authToken;
    const badBearer = bearerToken !== undefined && bearerToken !== authToken;
    if (badIdeAuth || badBearer) {
      try {
        socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      } catch {
        // Ignore.
      }
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit("connection", ws, req);
    });
  }

  server.on("upgrade", onUpgrade);

  return {
    broadcast(): void {
      const selection = getSelection();
      if (!selection) return;
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "selection_changed",
        params: selection,
      });
      for (const ws of sockets) {
        if (ws.readyState !== ws.OPEN) continue;
        try {
          ws.send(payload);
        } catch {
          // Ignore send errors on half-closed sockets.
        }
      }
    },
    mention(params: IdeMentionParams): void {
      const payload = JSON.stringify({
        jsonrpc: "2.0",
        method: "at_mentioned",
        params,
      });
      for (const ws of sockets) {
        if (ws.readyState !== ws.OPEN) continue;
        try {
          ws.send(payload);
        } catch {
          // Ignore send errors on half-closed sockets.
        }
      }
    },
    socketCount(): number {
      return sockets.size;
    },
    dispose(): void {
      server.removeListener("upgrade", onUpgrade);
      for (const ws of sockets) {
        try {
          ws.close();
        } catch {
          // Ignore.
        }
      }
      sockets.clear();
      wss.close();
    },
  };
}
