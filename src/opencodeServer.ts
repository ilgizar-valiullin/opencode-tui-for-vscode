import { ChildProcess, spawn, execSync, execFileSync } from "child_process";
import { randomBytes } from "crypto";
import { createServer } from "net";
import { existsSync, readFileSync } from "fs";
import { OpenCodeClient } from "./httpClient";
import * as path from "path";
import * as os from "os";

const TAG = "[opencode]";

function log(msg: string): void { console.log(`${TAG} ${msg}`); }
function logErr(msg: string): void { console.error(`${TAG} ${msg}`); }

export class OpenCodeServerManager {
  private helper_: ChildProcess | null = null;
  private serve_: ChildProcess | null = null;
  private port_: number = 0;
  private client_: OpenCodeClient | null = null;
  private cwd_: string = "";
  private mcpPort_: number = 0;
  private password_: string | null = null;
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
      const count = await runCleanup();
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

  /**
   * v2-only flow: headless `serve --port N` (own child process,
   * password-secured API) + TUI in the PTY attached via `--server <url>`.
   * The same generated OPENCODE_SERVER_PASSWORD is shared by both processes
   * and the API client. OpenCode v1 is no longer supported.
   */
  async start(openCodePath: string, preferredPort?: number, cwd?: string): Promise<void> {
    if (this.helper_) return;
    this.port_ = preferredPort && preferredPort > 0 ? preferredPort : await findFreePort();
    this.cwd_ = cwd ?? process.cwd();
    // serve runs via plain child_process.spawn (no shell, no PTY), so it
    // needs the direct .exe rather than a .cmd shim.
    const exe = toDirectExecutable(resolveOcPath(openCodePath));
    const major = detectMajorVersion(exe);
    if (major !== 2) {
      throw new Error(
        `Unsupported opencode major version ${major}: this extension requires OpenCode v2.x.`
      );
    }
    return this.startServe(exe);
  }

  private async startServe(exe: string): Promise<void> {
    const password = randomBytes(24).toString("hex");
    this.password_ = password;
    const base = `http://127.0.0.1:${this.port_}`;

    log(`Starting v2 serve on port ${this.port_}, oc=${exe}`);

    const serve = spawn(exe, ["serve", "--port", String(this.port_)], {
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        OPENCODE_SERVER_PASSWORD: password,
        ...(this.mcpPort_ ? { OPENCODE_MCP_PORT: String(this.mcpPort_) } : {}),
      },
    });
    this.serve_ = serve;
    serve.on("error", (e) => logErr(`serve spawn failed: ${e.message}`));
    serve.on("exit", (code) => {
      log(`serve exited (code ${code})`);
      if (this.serve_ === serve) {
        this.serve_ = null;
        this.client_ = null;
        this.mcpDisconnectCallback_?.();
      }
    });

    this.client_ = new OpenCodeClient(base, { password });
    await this.pollInfo(30000);

    const spawnMsg: Record<string, unknown> = {
      type: "spawn",
      path: exe,
      args: ["--server", base],
      cwd: this.cwd_,
      password,
    };
    if (this.mcpPort_) spawnMsg.mcpPort = this.mcpPort_;
    return this.spawnTuiPty(exe, spawnMsg, "Starting TUI");
  }

  /** Wait until the v2 serve API answers (or the serve process dies). */
  private pollInfo(timeoutMs: number): Promise<void> {
    const t0 = Date.now();
    return new Promise((resolve, reject) => {
      const poll = () => {
        if (!this.serve_ || !this.client_) {
          reject(new Error("serve exited before becoming ready"));
          return;
        }
        this.client_.health().then((s) => {
          if (s.healthy) resolve();
          else setTimeout(poll, 500);
        }).catch(() => {
          if (!this.serve_) {
            reject(new Error("serve exited before becoming ready"));
            return;
          }
          if (Date.now() - t0 > timeoutMs) reject(new Error("Timed out waiting for opencode serve API"));
          else setTimeout(poll, 500);
        });
      };
      poll();
    });
  }

  /**
   * Spawn the TUI inside the node-pty helper. Resolves once the PTY reports
   * the child pid (the serve API was already proven healthy before attaching
   * the TUI).
   */
  private spawnTuiPty(
    ocPath: string,
    spawnMsg: Record<string, unknown>,
    spawnLabel: string
  ): Promise<void> {
    const helperPath = path.resolve(__dirname, "ptyHelper.js");
    const nodeExe = findNode();

    log(`${spawnLabel} on port ${this.port_}, oc=${ocPath}, exe=${nodeExe}`);

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
            if (!settled) done();
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

      this.helper_.stdin?.write(JSON.stringify(spawnMsg) + "\n");
    });
  }

  async stop(): Promise<void> {
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

    if (this.serve_) {
      const serve = this.serve_;
      this.serve_ = null;
      if (serve.exitCode === null) {
        try { serve.kill(); } catch { /* */ }
        await Promise.race([
          new Promise<void>((resolve) => serve.once("exit", () => resolve())),
          new Promise<void>((resolve) => setTimeout(resolve, 3000)),
        ]);
        try { serve.kill(); } catch { /* */ }
      }
    }

    this.client_ = null; this.port_ = 0; this.password_ = null;
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

function resolveViaPath(name: string): string {
  const cmd = process.platform === "win32" ? `where ${name}` : `which ${name}`;
  let out = "";
  try {
    out = execSync(cmd, { encoding: "utf8", timeout: 5000 }).trim();
  } catch {
    throw new Error(
      `opencode not found in PATH (looked up "${name}"). Install opencode or set opencode-tui-unofficial.opencodePath to a full path.`
    );
  }
  const candidates = out.split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
  if (process.platform === "win32") {
    // Prefer directly runnable binaries. npm-style .cmd/.bat shims are
    // resolved to their underlying .exe so plain child_process.spawn and
    // execFileSync (which cannot run batch files) work and kill() targets
    // the real process instead of an orphaning cmd.exe wrapper.
    let fallback: string | null = null;
    for (const c of candidates) {
      const lower = c.toLowerCase();
      let present = false;
      try { present = existsSync(c); } catch { /* */ }
      if (!present) continue;
      if (lower.endsWith(".exe")) return c;
      if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
        const target = resolveCmdShimTarget(c);
        if (target) return target;
        fallback = fallback ?? c;
        continue;
      }
      fallback = fallback ?? c;
    }
    if (fallback) return fallback;
  } else {
    for (const c of candidates) {
      try { if (existsSync(c)) return c; } catch { /* */ }
    }
  }
  throw new Error(
    `opencode not found in PATH (looked up "${name}"). Install opencode or set opencode-tui-unofficial.opencodePath to a full path.`
  );
}

function resolveOcPath(configPath: string): string {
  const trimmed = (configPath ?? "").trim();
  // Not configured or bare "opencode" -> resolve via PATH
  if (!trimmed || trimmed === "opencode") {
    return resolveViaPath("opencode");
  }
  // Explicit path (absolute or contains a separator) -> use as-is, error if missing
  if (path.isAbsolute(trimmed) || trimmed.includes(path.sep) || trimmed.includes("/")) {
    if (existsSync(trimmed)) return trimmed;
    throw new Error(`opencode not found at configured path: ${trimmed}`);
  }
  // Any other bare command name -> resolve that name via PATH, error if missing
  return resolveViaPath(trimmed);
}

/**
 * Best-effort resolution of a Windows .cmd/.bat shim (npm-style) to the
 * underlying .exe it wraps, e.g. "%dp0%\node_modules\<pkg>\bin\app.exe".
 * Returns null when no runnable target can be determined.
 */
function resolveCmdShimTarget(cmdPath: string): string | null {
  let text = "";
  try {
    text = readFileSync(cmdPath, "utf8");
  } catch {
    return null;
  }
  const dir = path.dirname(cmdPath);
  const dp0 = /%~?dp0%([^"\r\n]*?\.exe)/gi;
  let m: RegExpExecArray | null;
  while ((m = dp0.exec(text)) !== null) {
    const full = path.join(dir, m[1].replace(/\//g, path.sep));
    try {
      if (existsSync(full)) return full;
    } catch { /* */ }
  }
  const abs = text.match(/"([A-Za-z]:\\[^"]+?\.exe)"/i);
  if (abs) {
    try {
      if (existsSync(abs[1])) return abs[1];
    } catch { /* */ }
  }
  return null;
}

/**
 * Map a resolved opencode path to something plain child_process APIs can
 * execute directly (no shell). .exe passes through; .cmd/.bat must resolve
 * to their target .exe, otherwise an actionable error is thrown.
 */
function toDirectExecutable(ocPath: string): string {
  if (process.platform !== "win32") return ocPath;
  const lower = ocPath.toLowerCase();
  if (lower.endsWith(".exe")) return ocPath;
  if (lower.endsWith(".cmd") || lower.endsWith(".bat")) {
    const target = resolveCmdShimTarget(ocPath);
    if (target) return target;
    throw new Error(
      `opencode shim "${ocPath}" does not point at a runnable .exe. ` +
      `Set opencode-tui-unofficial.opencodePath to the full opencode.exe path.`
    );
  }
  return ocPath;
}

function detectMajorVersion(ocPath: string): 1 | 2 {
  let out = "";
  try {
    // .cmd/.bat cannot run via execFileSync (CreateProcess); go through the
    // shell for those so --version works for any shim. .exe runs directly.
    const lower = ocPath.toLowerCase();
    if (process.platform === "win32" && (lower.endsWith(".cmd") || lower.endsWith(".bat") || lower.endsWith(".ps1"))) {
      out = execSync(`"${ocPath}" --version`, { encoding: "utf8", timeout: 10000 }).trim();
    } else {
      out = execFileSync(ocPath, ["--version"], { encoding: "utf8", timeout: 10000 }).trim();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    throw new Error(`Cannot run "${ocPath}" --version: ${msg.substring(0, 200)}`);
  }
  const m = out.match(/(\d+)\.\d+\.\d+/);
  if (!m) {
    throw new Error(
      `Unrecognized opencode version output: "${out.substring(0, 120)}" (need v1.x or v2.x)`
    );
  }
  const major = parseInt(m[1], 10);
  if (major === 1 || major === 2) return major;
  throw new Error(
    `Unsupported opencode major version ${major} (need v1.x or v2.x): "${out.substring(0, 120)}"`
  );
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
