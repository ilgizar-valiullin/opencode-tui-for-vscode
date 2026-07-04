import { ChildProcess, spawn, execSync } from "child_process";
import { createServer } from "net";
import { get } from "http";
import { existsSync } from "fs";
import { OpenCodeClient } from "./httpClient";
import * as path from "path";
import * as os from "os";

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
  private mcpDisconnectCallback_: (() => void) | null = null;

  // ─── Watchdog (static singleton) ───
  private static watchdog_: ChildProcess | null = null;
  /** Set by extension.ts from user config — controls whether watchdog spawns */
  static watchdogEnabled = true;

  /**
   * Start the orphan-cleanup watchdog as a detached process.
   * Spawns watchdog.js which monitors this extension host's stdin pipe.
   * When the pipe breaks (extension host dies), watchdog waits 15s then
   * runs WMI-based orphan cleanup.
   */
  static startWatchdog(): void {
    if (this.watchdog_) return;

    const watchdogPath = path.resolve(__dirname, "watchdog.js");
    if (!existsSync(watchdogPath)) {
      log("watchdog.js not found, skipping watchdog");
      return;
    }

    let nodeExe: string;
    try {
      nodeExe = findNode();
    } catch {
      log("system Node.js not found, skipping watchdog");
      return;
    }

    const watchdogLogFile = path.join(os.tmpdir(), `opencode-watchdog-${Date.now()}.log`);

    try {
      const proc = spawn(nodeExe, [watchdogPath, "--log-file", watchdogLogFile], {
        stdio: ["pipe", "pipe", "pipe"],
        detached: true,
        windowsHide: true,
        env: { ...process.env },
      });

      this.watchdog_ = proc;

      let ready = false;
      proc.stdout?.setEncoding("utf8");
      proc.stdout?.on("data", (chunk: string) => {
        if (!ready && chunk.includes("WATCHDOG_READY")) {
          ready = true;
          log(`Watchdog started (PID ${proc.pid})`);
        }
      });

      proc.stderr?.setEncoding("utf8");
      proc.stderr?.on("data", (chunk: string) => {
        for (const line of chunk.split("\n").filter(Boolean)) {
          log(`[watchdog:stderr] ${line.trim()}`);
        }
      });

      proc.on("exit", (code) => {
        log(`Watchdog exited (code ${code})`);
        if (this.watchdog_ === proc) this.watchdog_ = null;
      });

      proc.on("error", (e) => {
        logErr(`Watchdog error: ${e.message}`);
        this.watchdog_ = null;
      });

      // Unref so it doesn't keep the process alive
      proc.unref();

      log(`Watchdog spawned (PID ${proc.pid}, log=${watchdogLogFile})`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr(`Failed to start watchdog: ${msg}`);
    }
  }

  static stopWatchdog(): void {
    if (this.watchdog_) {
      try {
        this.watchdog_.kill("SIGTERM");
      } catch { /* ignore */ }
      this.watchdog_ = null;
    }
  }

  /**
   * One-shot startup cleanup: scan and kill orphan opencode processes
   * left from a previous crashed/stale extension session.
   */
  static async startupCleanup(): Promise<void> {
    try {
      const { runCleanup } = await import("./cleanup");
      const count = await runCleanup({ quiet: false });
      if (count > 0) log(`Startup cleanup removed ${count} orphan processes`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr(`Startup cleanup failed: ${msg.substring(0, 200)}`);
    }
  }

  get mcpPort(): number { return this.mcpPort_; }
  setMcpPort(port: number): void { this.mcpPort_ = port; }

  get client(): OpenCodeClient | null { return this.client_; }
  get port(): number { return this.port_; }
  get cwd(): string { return this.cwd_; }

  onMcpClientDisconnect(cb: () => void): void {
    this.mcpDisconnectCallback_ = cb;
  }

  onStdout(cb: (data: string) => void): void {
    this.stdoutCallback_ = cb;
    for (const c of this.stdoutBuffer_) cb(c);
    this.stdoutBuffer_ = [];
  }

  writeToStdin(data: string): void {
    if (this.helper_?.stdin?.writable) {
      this.helper_.stdin.write(JSON.stringify({ type: "stdin", data }) + "\n");
    }
  }

  resizePty(cols: number, rows: number): void {
    if (this.helper_?.stdin?.writable) {
      this.helper_.stdin.write(JSON.stringify({ type: "resize", cols, rows }) + "\n");
    }
  }

  async start(openCodePath: string, preferredPort?: number, cwd?: string): Promise<void> {
    if (this.helper_) return;
    this.port_ = preferredPort && preferredPort > 0 ? preferredPort : await findFreePort();
    this.cwd_ = cwd ?? process.cwd();
    const ocPath = resolveOcPath(openCodePath);
    const helperPath = path.resolve(__dirname, "ptyHelper.js");
    const nodeExe = findNode();

    log(`Starting PTY on port ${this.port_}, oc=${ocPath}, exe=${nodeExe}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return; settled = true;
        if (err) { logErr(`FAILED: ${err.message}`); reject(err); }
        else {
          log(`Ready on port ${this.port_}`);
          // Start watchdog after server is healthy
          if (OpenCodeServerManager.watchdogEnabled) {
            OpenCodeServerManager.startWatchdog();
          }
          resolve();
        }
      };

      const proc = spawn(nodeExe, [helperPath], {
        stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...process.env },
      });
      this.helper_ = proc;

      proc.on("error", (e) => done(new Error(`Helper: ${e.message}`)));
      proc.on("exit", (code) => {
        if (!settled) done(new Error(`Helper exited code=${code}`));
        if (this.helper_ === proc) {
          this.helper_ = null; this.client_ = null;
          this.mcpDisconnectCallback_?.();
        }
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
            this.mcpDisconnectCallback_?.();
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
        const timeout = 30000;
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
      const helper = this.helper_;
      helper.stdin?.write('{"type":"kill"}\n');

      // Give opencode up to 5s to exit gracefully and clean up child processes
      await Promise.race([
        new Promise<void>((resolve) => helper.once("exit", () => resolve())),
        new Promise<void>((resolve) => setTimeout(resolve, 5000)),
      ]);

      // Force kill if still alive
      if (this.helper_) {
        log("Graceful shutdown timeout, force-killing helper");
        this.helper_.kill();
        this.helper_ = null;
      }
    }

    this.client_ = null; this.port_ = 0;
    this.mcpDisconnectCallback_?.();
  }

  isRunning(): boolean { return this.helper_ !== null && this.helper_.exitCode === null; }
}

function findNode(): string {
  if (process.platform === "win32") {
    for (const c of ["C:\\Program Files\\nodejs\\node.exe", "C:\\Program Files (x86)\\nodejs\\node.exe"]) {
      if (existsSync(c)) return c;
    }
  }
  const binName = process.platform === "win32" ? "node.exe" : "node";
  const pathDirs = (process.env.PATH || "").split(path.delimiter);
  for (const dir of pathDirs) {
    const full = path.join(dir, binName);
    try { if (existsSync(full)) return full; } catch { /* */ }
  }
  throw new Error(
    "System Node.js not found. Install Node.js from https://nodejs.org " +
    "(required for node-pty native module compatibility)."
  );
}

function resolveOcPath(configPath: string): string {
  // Check known locations on Windows first
  if (process.platform === "win32" && process.env.LOCALAPPDATA) {
    const local = `${process.env.LOCALAPPDATA}\\OpenCode\\opencode.exe`;
    if (existsSync(local)) return local;
  }
  // If already a full valid path, use as-is
  if (path.isAbsolute(configPath) && existsSync(configPath)) return configPath;
  // If it's just a command name, resolve via shell PATH
  if (!path.isAbsolute(configPath) && !configPath.includes(path.sep)) {
    try {
      // Extend PATH with common npm bin directories — macOS GUI apps don't inherit shell PATH
      const extra = [
        "/opt/homebrew/bin",
        "/usr/local/bin",
        path.join(os.homedir(), ".npm-global", "bin"),
        path.join(os.homedir(), ".local", "bin"),
      ];
      const pathEnv = [process.env.PATH, ...extra].filter(Boolean).join(path.delimiter);
      const cmd = process.platform === "win32" ? `where ${configPath}` : `which ${configPath}`;
      const result = execSync(cmd, { encoding: "utf8", timeout: 5000, env: { ...process.env, PATH: pathEnv } })
        .trim().split(/\r?\n/)[0];
      if (result && existsSync(result)) return result.trim();
    } catch {
      // not found in PATH, fall through
    }
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


