import { get as httpGet, request as httpRequest } from "http";
import { ServerStatus, SessionInfo, TuiCommandId } from "./types";

export class OpenCodeClient {
  constructor(private baseUrl: string) {}

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const url = new URL(path, this.baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers: {
            "Content-Type": "application/json",
            ...(bodyStr ? { "Content-Length": String(Buffer.byteLength(bodyStr)) } : {}),
          },
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                resolve(JSON.parse(data) as T);
              } catch {
                resolve(data as unknown as T);
              }
            } else {
              reject(new Error(`OpenCode API ${method} ${path}: ${res.statusCode} — ${data.substring(0, 200)}`));
            }
          });
        }
      );

      req.on("error", (err) => {
        reject(new Error(`OpenCode API ${method} ${path}: ${err.message}`));
      });

      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error(`OpenCode API ${method} ${path}: timeout`));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  // ─── Health ───

  async health(): Promise<ServerStatus> {
    return this.request<ServerStatus>("GET", "/global/health");
  }

  // ─── Sessions ───

  async listSessions(): Promise<SessionInfo[]> {
    return this.request<SessionInfo[]>("GET", "/session");
  }

  async createSession(): Promise<SessionInfo> {
    return this.request<SessionInfo>("POST", "/session");
  }

  async getSession(id: string): Promise<SessionInfo> {
    return this.request<SessionInfo>("GET", `/session/${id}`);
  }

  async deleteSession(id: string): Promise<boolean> {
    return this.request<boolean>("DELETE", `/session/${id}`);
  }

  // ─── Messages ───

  async sendMessage(
    sessionId: string,
    parts: unknown[],
    opts?: { model?: string; agent?: string }
  ): Promise<unknown> {
    return this.request("POST", `/session/${sessionId}/message`, {
      parts,
      ...opts,
    });
  }

  async sendMessageAsync(
    sessionId: string,
    parts: unknown[],
    opts?: { model?: string; agent?: string }
  ): Promise<boolean> {
    return this.request<boolean>("POST", `/session/${sessionId}/prompt_async`, {
      parts,
      ...opts,
    });
  }

  // ─── TUI Commands ───

  async executeTuiCommand(command: TuiCommandId): Promise<boolean> {
    return this.request<boolean>("POST", "/tui/execute-command", { command });
  }

  async appendPrompt(text: string): Promise<boolean> {
    return this.request<boolean>("POST", "/tui/append-prompt", { text });
  }

  async submitPrompt(): Promise<boolean> {
    return this.request<boolean>("POST", "/tui/submit-prompt");
  }

  async clearPrompt(): Promise<boolean> {
    return this.request<boolean>("POST", "/tui/clear-prompt");
  }

  // ─── File operations ───

  async readFile(path: string): Promise<{ content: string }> {
    return this.request("GET", `/file/content?path=${encodeURIComponent(path)}`);
  }
}
