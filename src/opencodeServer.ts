import { ChildProcess, spawn } from "child_process";
import { createServer } from "net";
import { get } from "http";
import { existsSync } from "fs";
import { OpenCodeClient } from "./httpClient";
import * as path from "path";

const TAG = "[opencode]";

function log(msg: string): void { console.log(`${TAG} ${msg}`); }
function logErr(msg: string): void { console.error(`${TAG} ${msg}`); }

export class OpenCodeServerManager {
  private helper_: ChildProcess | null = null;
  private port_: number = 0;
  private client_: OpenCodeClient | null = null;
  private cwd_: string = "";
  private mcpPort_: number = 0;
  private stdoutCallback_: ((data: string) => void) | null = null;
  private stdoutBuffer_: string[] = [];

  get mcpPort(): number { return this.mcpPort_; }
  setMcpPort(port: number): void { this.mcpPort_ = port; }

  get client(): OpenCodeClient | null { return this.client_; }
  get port(): number { return this.port_; }
  get cwd(): string { return this.cwd_; }

  onStdout(cb: (data: string) => void): void {
    this.stdoutCallback_ = cb;
    for (const c of this.stdoutBuffer_) cb(c);
    this.stdoutBuffer_ = [];
  }

  writeToStdin(data: string): void {
    this.helper_?.stdin?.writable &&
      this.helper_.stdin.write(JSON.stringify({ type: "stdin", data }) + "\n");
  }

  resizePty(cols: number, rows: number): void {
    this.helper_?.stdin?.writable &&
      this.helper_.stdin.write(JSON.stringify({ type: "resize", cols, rows }) + "\n");
  }

  async start(openCodePath: string, preferredPort?: number, cwd?: string): Promise<void> {
    if (this.helper_) return;
    this.port_ = preferredPort && preferredPort > 0 ? preferredPort : await findFreePort();
    this.cwd_ = cwd ?? process.cwd();
    const ocPath = resolveOcPath(openCodePath);
    const helperPath = path.resolve(__dirname, "ptyHelper.js");
    const nodeExe = findNode();

    log(`Starting PTY on port ${this.port_}, oc=${ocPath}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return; settled = true;
        if (err) { logErr(`FAILED: ${err.message}`); reject(err); }
        else { log(`Ready on port ${this.port_}`); resolve(); }
      };

      this.helper_ = spawn(nodeExe, [helperPath], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env },
      });

      this.helper_.on("error", (e) => done(new Error(`Helper: ${e.message}`)));
      this.helper_.on("exit", (code) => {
        if (!settled) done(new Error(`Helper exited code=${code}`));
        this.helper_ = null; this.client_ = null;
      });

      this.helper_.stderr?.on("data", (c: Buffer) => {
        const s = c.toString().trim();
        if (s) console.error(`${TAG} ${s.substring(0, 300)}`);
      });

      let outBuf = "";
      this.helper_.stdout?.setEncoding("utf8");
      this.helper_.stdout?.on("data", (chunk: string) => {
        outBuf += chunk;
        let idx: number;
        while ((idx = outBuf.indexOf("\0")) !== -1) {
          const frame = outBuf.substring(0, idx);
          outBuf = outBuf.substring(idx + 1);
          if (!frame || frame.length < 1) continue;

          const prefix = frame[0];
          const payload = frame.substring(1);

          if (prefix === "R") {
            try { const m = JSON.parse(payload); log(`PTY pid=${m.pid}`); } catch { /* */ }
            if (!settled) pollHealth();
          }
          else           if (prefix === "D") {
            if (this.stdoutCallback_) this.stdoutCallback_(payload);
            else this.stdoutBuffer_.push(payload);
          }
          else if (prefix === "E") {
            let code: number | undefined;
            try { code = JSON.parse(payload).code; } catch { /* */ }
            if (!settled) done(new Error(`PTY code=${code}`));
            this.helper_ = null; this.client_ = null;
          }
        }
      });

      const spawnMsg: Record<string, unknown> = { type: "spawn", path: ocPath, port: this.port_ };
      if (cwd) spawnMsg.cwd = cwd;
      if (this.mcpPort_) spawnMsg.mcpPort = this.mcpPort_;

      this.helper_.stdin?.write(JSON.stringify(spawnMsg) + "\n");

      const pollHealth = () => {
        const base = `http://localhost:${this.port_}`;
        const t0 = Date.now();
        const timeout = 15000;
        const poll = () => {
          if (settled) return;
          get(`${base}/global/health`, (res) => {
            let body = "";
            res.on("data", (c: Buffer) => { body += c.toString(); });
            res.on("end", () => {
              if (settled) return;
              try {
                const s = JSON.parse(body) as { healthy: boolean; version: string };
                if (s.healthy) { this.client_ = new OpenCodeClient(base); done(); }
                else setTimeout(poll, 1000);
              } catch { setTimeout(poll, 1000); }
            });
          }).on("error", () => {
            if (Date.now() - t0 > timeout) done(new Error("Timeout"));
            else setTimeout(poll, 1000);
          }).setTimeout(3000, function(this: any) { this.destroy(); });
        };
        setTimeout(poll, 1500);
      };
    });
  }

  async stop(): Promise<void> {
    if (this.client_) { try { await this.client_.executeTuiCommand("app_exit"); } catch { /* */ } }
    if (this.helper_) {
      this.helper_.stdin?.write('{"type":"kill"}\n');
      this.helper_.kill(); this.helper_ = null;
    }
    this.client_ = null; this.port_ = 0;
  }

  isRunning(): boolean { return this.helper_ !== null && this.helper_.exitCode === null; }
}

function findNode(): string {
  if (process.platform === "win32") {
    for (const c of ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"]) {
      if (existsSync(c)) return c;
    }
  }
  return process.execPath;
}

function resolveOcPath(configPath: string): string {
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const local = `${process.env.LOCALAPPDATA}\\OpenCode\\opencode.exe`;
    if (existsSync(local)) return local;
  }
  return configPath;
}

function findFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      if (a && typeof a === "object") { const p = a.port; s.close(() => resolve(p)); }
      else { s.close(() => reject(new Error("No port"))); }
    });
    s.on("error", reject);
  });
}

export const serverManager = new OpenCodeServerManager();
