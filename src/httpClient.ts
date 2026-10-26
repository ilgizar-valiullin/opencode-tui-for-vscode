import { request as httpRequest } from "http";
import { ServerStatus, SessionInfo } from "./types";

export interface OpenCodeClientOptions {
  /** HTTP Basic-auth password printed by `opencode serve` on startup */
  password?: string;
}

/**
 * Typed client for the OpenCode v2 HTTP API. All routes live under `/api`,
 * require Basic auth (`opencode:<password>`), and wrap payloads in
 * `{"data": ...}` envelopes (bare values like /api/info and /api/project
 * pass through unchanged).
 */
export class OpenCodeClient {
  private password_?: string;

  constructor(private baseUrl: string, opts?: OpenCodeClientOptions) {
    this.password_ = opts?.password;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown
  ): Promise<T> {
    const fullPath = `/api${path}`;
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
                if (
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
    const info = await this.request<{ version: string }>("GET", "/info");
    return { healthy: true, version: info.version };
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

  // ─── File operations ───

  async readFile(path: string): Promise<{ content: string }> {
    return this.request("GET", `/file/content?path=${encodeURIComponent(path)}`);
  }
}
