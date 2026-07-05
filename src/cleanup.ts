import { spawn, execSync, exec } from "child_process";
import * as fs from "fs";

const RW = 8 * 1024;

export interface ProcessInfo {
  pid: number;
  name: string;
  ppid: number;
  commandLine: string;
}

export interface CleanupOptions {
  graceMs?: number;
  quiet?: boolean;
}

const MCP_PATTERNS = [
  "mcp-web-hound",
  "agentmemory",
  "cv-docs-mcp",
  "mcp-server-time",
  "lsp-mcp-launcher",
  "opencode-mcp-headless-edge",
  "screenshot-mcp",
  "opencode-tui",
];

const isWin = process.platform === "win32";

function isOpenCodeRelated(p: ProcessInfo): boolean {
  const name = p.name.toLowerCase();
  const cmd = p.commandLine.toLowerCase();
  const base = name.split(/[/\\]/).pop() || name;

  if (cmd.includes("watchdog.js")) return false;

  if (base === "opencode" || base === "opencode.exe") return true;
  if (base === "node" || base === "node.exe" || base === "nodejs") {
    if (cmd.includes("ptyHelper")) return true;
    return MCP_PATTERNS.some((pat) => cmd.includes(pat));
  }
  if (isWin && (base === "cmd.exe" || base === "cmd")) {
    return MCP_PATTERNS.some((pat) => cmd.includes(pat));
  }
  if (!isWin && ["sh", "bash", "zsh", "dash"].includes(base)) {
    return MCP_PATTERNS.some((pat) => cmd.includes(pat));
  }
  return false;
}

// ─── Process enumeration ───

async function win32FetchProcesses(): Promise<ProcessInfo[]> {
  return new Promise((resolve, reject) => {
    const proc = spawn("wmic", [
      "process", "get",
      "ProcessId,ParentProcessId,Name,CommandLine",
      "/format:list",
    ], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });

    let stdout = "";
    let stderr = "";
    proc.stdout?.setEncoding("utf8");
    proc.stdout?.on("data", (chunk: string) => { stdout += chunk; });
    proc.stderr?.setEncoding("utf8");
    proc.stderr?.on("data", (chunk: string) => { stderr += chunk; });
    proc.on("error", reject);
    proc.on("exit", (code) => {
      if (code !== 0 && !quietDefault) {
        console.error("[opencode] [cleanup] wmic exit code", code, stderr.substring(0, RW));
      }
      resolve(parseWmicList(stdout));
    });
  });
}

async function unixFetchProcesses(): Promise<ProcessInfo[]> {
  if (process.platform === "linux") {
    try { return await linuxProcFs(); } catch { /* fall through to ps */ }
  }
  return parsePsOutput(execSync("ps -eo pid,ppid,comm,args", { stdio: ["ignore", "pipe", "pipe"], timeout: 5000 }).toString());
}

async function linuxProcFs(): Promise<ProcessInfo[]> {
  const dirs = fs.readdirSync("/proc");
  const procs: ProcessInfo[] = [];
  for (const dir of dirs) {
    if (!/^\d+$/.test(dir)) continue;
    const pid = parseInt(dir, 10);
    try {
      const status = fs.readFileSync(`/proc/${dir}/status`, "utf8");
      const cmdlineRaw = fs.readFileSync(`/proc/${dir}/cmdline`, "utf8");
      const name = (status.match(/^Name:\s*(.+)$/m) ?? [])[1] ?? "";
      const ppid = parseInt((status.match(/^PPid:\s*(\d+)$/m) ?? [])[1] ?? "", 10);
      const commandLine = cmdlineRaw.replace(/\0/g, " ").trim();
      if (!pid || !name) continue;
      procs.push({ pid, ppid, name, commandLine });
    } catch { /* process died between readdir and read */ }
  }
  return procs;
}

function parsePsOutput(output: string): ProcessInfo[] {
  const lines = output.trim().split(/\r?\n/);
  const procs: ProcessInfo[] = [];
  for (const line of lines) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
    if (!m) continue;
    const pid = parseInt(m[1], 10);
    const ppid = parseInt(m[2], 10);
    const name = m[3];
    const commandLine = m[4] ?? "";
    if (!pid) continue;
    procs.push({ pid, ppid, name, commandLine });
  }
  return procs;
}

function parseWmicList(output: string): ProcessInfo[] {
  const procs: ProcessInfo[] = [];
  for (const block of output.split(/\r?\n(?=\S)/)) {
    const lines = block.trim().split(/\r?\n/);
    if (lines.length < 3) continue;
    const record: Record<string, string> = {};
    for (const line of lines) {
      const idx = line.indexOf("=");
      if (idx === -1) continue;
      record[line.substring(0, idx).trim().toLowerCase()] = line.substring(idx + 1).trim();
    }
    const pid = parseInt(record["processid"] ?? "", 10);
    const ppid = parseInt(record["parentprocessid"] ?? "", 10);
    const name = record["name"] ?? "";
    const commandLine = record["commandline"] ?? "";
    if (!pid || !name) continue;
    procs.push({ pid, ppid, name, commandLine });
  }
  return procs;
}

// ─── Shared ───

function buildPidSet(procs: ProcessInfo[]): Set<number> {
  const s = new Set<number>();
  for (const p of procs) s.add(p.pid);
  return s;
}

export function findOrphans(procs: ProcessInfo[]): ProcessInfo[] {
  const livePids = buildPidSet(procs);
  const orphans: ProcessInfo[] = [];
  for (const p of procs) {
    if (!isOpenCodeRelated(p)) continue;
    // On Unix, orphaned processes are reparented to init (PID 1)
    if (!isWin && p.ppid === 1) {
      orphans.push(p);
      continue;
    }
    // On Windows, orphaned child processes have PPID=0 when parent dies
    if (p.ppid !== 0 && !livePids.has(p.ppid)) {
      orphans.push(p);
    }
  }
  return orphans;
}

export function findTree(procs: ProcessInfo[], rootPid: number): ProcessInfo[] {
  const childMap = new Map<number, ProcessInfo[]>();
  for (const p of procs) {
    const list = childMap.get(p.ppid);
    if (list) list.push(p);
    else childMap.set(p.ppid, [p]);
  }
  const result: ProcessInfo[] = [];
  const queue = [rootPid];
  const visited = new Set<number>();
  while (queue.length > 0) {
    const pid = queue.shift()!;
    if (visited.has(pid)) continue;
    visited.add(pid);
    const children = childMap.get(pid);
    if (children) {
      for (const child of children) {
        result.push(child);
        queue.push(child.pid);
      }
    }
  }
  return result;
}

let quietDefault = false;

export function setQuietDefault(q: boolean): void {
  quietDefault = q;
}

// ─── Platform-specific killing ───

function execAsync(cmd: string, opts?: { timeout?: number }): Promise<void> {
  return new Promise((resolve, reject) => {
    exec(cmd, { ...opts, maxBuffer: 1024 * 1024 }, (err) => {
      if (err) reject(err);
      else resolve();
    });
  });
}

async function killTree(pid: number, tree: ProcessInfo[], opts?: CleanupOptions): Promise<void> {
  const quiet = opts?.quiet ?? quietDefault;
  if (isWin) {
    try {
      await execAsync(`taskkill /T /F /PID ${pid}`, { timeout: 5000 });
      if (!quiet) console.log(`[opencode] [cleanup] Killed PID ${pid} and its tree`);
    } catch (e: unknown) {
      if (!quiet) {
        const msg = e instanceof Error ? e.message : String(e);
        console.warn(`[opencode] [cleanup] Failed to kill PID ${pid}: ${msg.substring(0, 200)}`);
      }
    }
  } else {
    const allPids = [pid, ...tree.map((p) => p.pid)];
    await execAsync(`kill -TERM ${allPids.join(" ")}`, { timeout: 3000 }).catch(() => {});
    await new Promise((r) => setTimeout(r, 100));
    await execAsync(`kill -KILL ${allPids.join(" ")}`, { timeout: 3000 }).catch(() => {});
    if (!quiet) console.log(`[opencode] [cleanup] Killed PID ${pid} and its tree (${allPids.length} processes)`);
  }
}

function parentAlive(pid: number): boolean {
  if (isWin) {
    try {
      execSync(`tasklist /FI "PID eq ${pid}" /NH`, { stdio: "pipe", windowsHide: true, timeout: 3000 });
      return true;
    } catch { return false; }
  }
  try { execSync(`kill -0 ${pid}`, { stdio: "ignore", timeout: 3000 }); return true; } catch { return false; }
}

// ─── Public API ───

export async function fetchProcesses(): Promise<ProcessInfo[]> {
  return isWin ? win32FetchProcesses() : unixFetchProcesses();
}

export async function runCleanup(opts?: CleanupOptions): Promise<number> {
  const quiet = opts?.quiet ?? quietDefault;
  if (!quiet) console.log("[opencode] [cleanup] Scanning for opencode orphan processes...");

  let procs: ProcessInfo[];
  try {
    procs = await fetchProcesses();
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[opencode] [cleanup] Failed to fetch processes: ${msg}`);
    return 0;
  }

  const orphans = findOrphans(procs);
  if (orphans.length === 0) {
    if (!quiet) console.log("[opencode] [cleanup] No orphans found");
    return 0;
  }

  const killedPids = new Set<number>();
  for (const orphan of orphans) {
    if (killedPids.has(orphan.pid)) continue;
    const tree = findTree(procs, orphan.pid);
    const allPids = [orphan, ...tree];

    if (!quiet) {
      const desc = allPids.map((p) => `  PID ${p.pid} (${p.name})`).join("\n");
      console.log(`[opencode] [cleanup] Orphan root: PID ${orphan.pid} (${orphan.name})\n${desc}`);
    }

    await killTree(orphan.pid, tree, opts);
    killedPids.add(orphan.pid);
    for (const t of tree) killedPids.add(t.pid);
  }

  if (!quiet) console.log(`[opencode] [cleanup] Cleaned ${killedPids.size} orphan processes`);
  return killedPids.size;
}

// ─── Standalone entry point ───
if (require.main === module && !process.env.OPENCODE_IS_WATCHDOG) {
  const args = process.argv.slice(2);
  const quiet = args.includes("--quiet");
  setQuietDefault(quiet);

  const parentPidIdx = args.indexOf("--parent-pid");
  if (parentPidIdx !== -1 && parentPidIdx + 1 < args.length) {
    const parentPid = parseInt(args[parentPidIdx + 1], 10);
    if (isNaN(parentPid)) process.exit(1);

    const poll = () => {
      if (!parentAlive(parentPid)) {
        console.log("[opencode] [cleanup] Parent died, waiting 15s grace period...");
        setTimeout(() => {
          runCleanup({ quiet }).then((count) => {
            console.log(`[opencode] [cleanup] Done, cleaned ${count} orphans`);
            process.exit(0);
          });
        }, 15000);
        return;
      }
      setTimeout(poll, 1000);
    };
    poll();
  } else {
    runCleanup({ quiet }).then((count) => {
      console.log(`[opencode] [cleanup] Done, cleaned ${count} orphans`);
      process.exit(0);
    });
  }
}