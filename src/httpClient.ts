import { request as httpRequest } from "http";
import { ServerStatus, SessionInfo, TuiCommandId } from "./types";

export interface OpenCodeClientOptions {
  /** HTTP Basic-auth password (v2 `serve` requires it; v1 server has no auth) */
  password?: string;
  /** v2 API: prefix paths with /api and unwrap {"data"} envelopes */
  v2?: boolean;
}

export class OpenCodeClient {
  private password_?: string;
  private v2_: boolean;

  constructor(private baseUrl: string, opts?: OpenCodeClientOptions) {
    this.password_ = opts?.password;
    this.v2_ = opts?.v2 ?? false;
  }

  private fullPath(path: string): string {
    return this.v2_ ? `/api${path}` : path;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const fullPath = this.fullPath(path);
    const url = new URL(fullPath, this.baseUrl);
    const bodyStr = body !== undefined ? JSON.stringify(body) : undefined;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(bodyStr ? { "Content-Length": String(Buffer.byteLength(bodyStr)) } : {}),
    };
    if (this.password_) {
      headers["Authorization"] =
        "Basic " + Buffer.from(`opencode:${this.password_}`).toString("base64");
    }

    return new Promise((resolve, reject) => {
      const req = httpRequest(
        {
          hostname: url.hostname,
          port: url.port,
          path: url.pathname + url.search,
          method,
          headers,
        },
        (res) => {
          let data = "";
          res.on("data", (chunk: Buffer) => { data += chunk.toString(); });
          res.on("end", () => {
            if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
              try {
                const parsed = JSON.parse(data);
                // v2 wraps payloads in {"data": ...}; pass through when absent
                // (e.g. /api/info, /api/project return bare values).
                if (
                  this.v2_ &&
                  parsed !== null &&
                  typeof parsed === "object" &&
                  "data" in parsed
                ) {
                  resolve((parsed as { data: T }).data);
                } else {
                  resolve(parsed as T);
                }
              } catch {
                resolve(data as unknown as T);
              }
            } else {
              reject(new Error(`OpenCode API ${method} ${fullPath}: ${res.statusCode} — ${data.substring(0, 200)}`));
            }
          });
        }
      );

      req.on("error", (err) => {
        reject(new Error(`OpenCode API ${method} ${fullPath}: ${err.message}`));
      });

      req.setTimeout(5000, () => {
        req.destroy();
        reject(new Error(`OpenCode API ${method} ${fullPath}: timeout`));
      });

      if (bodyStr) {
        req.write(bodyStr);
      }
      req.end();
    });
  }

  // ─── Health ───

  async health(): Promise<ServerStatus> {
    if (this.v2_) {
      // v2 has no /global/health; /api/info carries {version, ...} when up.
      const info = await this.request<{ version: string }> ("GET", "/info");
      return { healthy: true, version: info.version };
    }
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

  // ─── TUI Commands (v1 only — v2 has no /tui routes) ───

  async executeTuiCommand(command: TuiCommandId): Promise<boolean> {
    if (this.v2_) return false;
    return this.request<boolean>("POST", "/tui/execute-command", { command });
  }

  async appendPrompt(text: string): Promise<boolean> {
    if (this.v2_) return false;
    return this.request<boolean>("POST", "/tui/append-prompt", { text });
  }

  async submitPrompt(): Promise<boolean> {
    if (this.v2_) return false;
    return this.request<boolean>("POST", "/tui/submit-prompt");
  }

  async clearPrompt(): Promise<boolean> {
    if (this.v2_) return false;
    return this.request<boolean>("POST", "/tui/clear-prompt");
  }

  // ─── File operations ───

  async readFile(path: string): Promise<{ content: string }> {
    return this.request("GET", `/file/content?path=${encodeURIComponent(path)}`);
  }
}
