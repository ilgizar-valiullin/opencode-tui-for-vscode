import { ChildProcess, spawn, execSync, execFileSync } from "child_process";
import { existsSync, readFileSync } from "fs";
import * as path from "path";
import * as os from "os";

const TAG = "[opencode]";

function log(msg: string): void { console.log(`${TAG} ${msg}`); }
function logErr(msg: string): void { console.error(`${TAG} ${msg}`); }

export class OpenCodeServerManager {
  private helper_: ChildProcess | null = null;
  private cwd_: string = "";
  private mcpPort_: number = 0;
  private editorPort_: number = 0;
  private bridgeUrl_: string = "";
  private bridgeToken_: string = "";
  private pluginDir_: string = "";
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

  /**
   * Port of the IDE WebSocket bridge (same HTTP server as MCP). Forwarded to
   * the TUI via OPENCODE_EDITOR_SSE_PORT so opencode discovers the IDE even
   * without scanning `~/.claude/ide/*.lock`. Applied on next start().
   */
  setEditorPort(port: number): void { this.editorPort_ = port; }

  /**
   * VS Code diagnostics bridge: same HTTP server as MCP (same port),
   * plus the bundled opencode plugin directory injected via env.
   * Applied on next start() — call before start.
   */
  setIdeBridge(url: string, token: string, pluginDir: string): void {
    this.bridgeUrl_ = url;
    this.bridgeToken_ = token;
    this.pluginDir_ = pluginDir;
  }

  get port(): number { return 0; }
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
   * TUI + embedded server flow: a single `opencode --standalone` process in
   * the PTY hosts its own private server instead of the background service.
   * No separate `serve` child, no allocated port, no password plumbing —
   * readiness is the PTY spawn ack. OpenCode v1 is no longer supported.
   */
  async start(openCodePath: string, _preferredPort?: number, cwd?: string): Promise<void> {
    if (this.helper_) return;
    this.cwd_ = cwd ?? process.cwd();
    // node-pty spawns without a shell, so it needs the direct .exe
    // rather than a .cmd shim.
    const exe = toDirectExecutable(resolveOcPath(openCodePath));
    const major = detectMajorVersion(exe);
    if (major !== 2) {
      throw new Error(
        `Unsupported opencode major version ${major}: this extension requires OpenCode v2.x.`
      );
    }
    const spawnMsg: Record<string, unknown> = {
      type: "spawn",
      path: exe,
      args: ["--standalone"],
      cwd: this.cwd_,
    };
    if (this.mcpPort_) spawnMsg.mcpPort = this.mcpPort_;
    if (this.editorPort_) spawnMsg.editorPort = this.editorPort_;
    if (this.bridgeUrl_) spawnMsg.bridgeUrl = this.bridgeUrl_;
    if (this.bridgeToken_) spawnMsg.bridgeToken = this.bridgeToken_;
    const extra = extraPluginEnv(process.env.OPENCODE_CONFIG_CONTENT, this.pluginDir_);
    if (extra.OPENCODE_CONFIG_CONTENT) spawnMsg.configContent = extra.OPENCODE_CONFIG_CONTENT;
    return this.spawnTuiPty(exe, spawnMsg, "Starting TUI (embedded server)");
  }

  /**
   * Spawn the TUI inside the node-pty helper. Resolves once the PTY reports
   * the child pid (the embedded server lives inside the TUI process itself).
   */
  private spawnTuiPty(
    ocPath: string,
    spawnMsg: Record<string, unknown>,
    spawnLabel: string
  ): Promise<void> {
    const helperPath = path.resolve(__dirname, "ptyHelper.js");
    const nodeExe = findNode();

    log(`${spawnLabel}, oc=${ocPath}, exe=${nodeExe}`);

    return new Promise((resolve, reject) => {
      let settled = false;
      const done = (err?: Error) => {
        if (settled) return; settled = true;
        if (err) { logErr(`FAILED: ${err.message}`); reject(err); }
        else {
          log(`Ready (pid ack)`);
          // Start watchdog after the TUI is up
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
          this.helper_ = null;
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
            this.helper_ = null;
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

/**
 * Merge the bundled VS Code bridge plugin into inline opencode config.
 * Plugin arrays merge across config sources, so user plugins are preserved.
 */
function extraPluginEnv(
  existing: string | undefined,
  pluginDir: string,
): Record<string, string> {
  if (!pluginDir) {
    return {};
  }
  try {
    const parsed = existing ? (JSON.parse(existing) as { plugins?: unknown }) : {};
    const prev = Array.isArray(parsed.plugins) ? (parsed.plugins as unknown[]) : [];
    const next = [...prev];
    if (!next.includes(pluginDir)) {
      next.push(pluginDir);
    }
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ ...parsed, plugins: next }) };
  } catch {
    return { OPENCODE_CONFIG_CONTENT: JSON.stringify({ plugins: [pluginDir] }) };
  }
}
