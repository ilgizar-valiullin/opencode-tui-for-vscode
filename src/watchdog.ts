/**
 * Watchdog — detached process monitoring extension host health.
 *
 * Protocol:
 *   Extension spawns this process child_process.spawn() with 'pipe' stdin.
 *   watchdog receives heartbeats (newlines) on stdin.
 *   If stdin closes (pipe breaks) — parent extension host died.
 *   Waits grace period, runs cleanup of orphan opencode processes.
 *
 * Usage (by extension):
 *   node watchdog.js --grace 15000
 *   node watchdog.js --log-file C:\path\to\watchdog.log
 */

import { runCleanup } from "./cleanup";
import { appendFileSync, existsSync, mkdirSync } from "fs";
import * as path from "path";
import * as os from "os";

const RW = 8 * 1024;

function parseArgs(): { graceMs: number; logFile: string } {
  const args = process.argv.slice(2);
  let graceMs = 15000;
  let logFile: string | null = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--grace" && i + 1 < args.length) {
      graceMs = parseInt(args[i + 1], 10);
      if (isNaN(graceMs) || graceMs < 1000) graceMs = 15000;
      i++;
    } else if (args[i] === "--log-file" && i + 1 < args.length) {
      logFile = args[i + 1];
      i++;
    }
  }

  return { graceMs, logFile: logFile ?? path.join(os.tmpdir(), `opencode-watchdog-${process.pid}.log`) };
}

const { graceMs, logFile } = parseArgs();

const pid = process.pid;

// Ensure log directory exists
try {
  const logDir = path.dirname(logFile);
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
} catch { /* best-effort */ }

function log(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stdout?.write(msg + "\n");
  try { appendFileSync(logFile, line + "\n"); } catch { /* best-effort */ }
}

function logErr(msg: string): void {
  const line = `[${new Date().toISOString()}] ${msg}`;
  process.stderr?.write(msg + "\n");
  try { appendFileSync(logFile, line + "\n"); } catch { /* best-effort */ }
}

log(`[watchdog:${pid}] === STARTED === log=${logFile}`);

// Suppress EPIPE errors after parent dies
process.stdout?.on("error", () => {});
process.stderr?.on("error", () => {});

// Send ready signal on stdout so extension knows watchdog is alive
process.stdout?.write(`WATCHDOG_READY:${pid}\n`);

let stdinClosed = false;
let cleanupRunning = false;

function startGracePeriod(): void {
  if (cleanupRunning) return;
  cleanupRunning = true;

  log(`[watchdog:${pid}] Extension host disconnected. Waiting ${graceMs}ms grace period...`);

  setTimeout(async () => {
    log(`[watchdog:${pid}] Grace period ended. Running orphan cleanup...`);
    try {
      const count = await runCleanup({ quiet: false });
      log(`[watchdog:${pid}] Cleanup complete. Removed ${count} orphan processes.`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      logErr(`[watchdog:${pid}] Cleanup failed: ${msg.substring(0, RW)}`);
    }

    // Self-destruct
    log(`[watchdog:${pid}] === EXIT 0 ===`);
    process.exit(0);
  }, graceMs);
}

// ─── Stdin heartbeat detection ───
// Extension sends periodic newlines. If pipe breaks — parent is dead.

process.stdin?.setEncoding("utf8");
process.stdin?.on("data", () => {
  // heartbeat received — parent is alive, reset timer (or just keep-alive)
  // We use `close` event, so no need to track timeouts
});

process.stdin?.on("end", () => {
  if (stdinClosed) return;
  stdinClosed = true;
  startGracePeriod();
});

process.stdin?.on("close", () => {
  if (stdinClosed) return;
  stdinClosed = true;
  startGracePeriod();
});

process.stdin?.on("error", () => {
  if (stdinClosed) return;
  stdinClosed = true;
  startGracePeriod();
});

// ─── Fallback: if no stdin after 30s, assume something's wrong but don't act ───
setTimeout(() => {
  if (!stdinClosed && !cleanupRunning) {
    process.stdout?.write(`WATCHDOG_ALIVE:${pid}\n`);
  }
}, 30000);

// Periodic keepalive — every 10s we write to stdout so extension can verify
setInterval(() => {
  if (!stdinClosed && !cleanupRunning) {
    process.stdout?.write(`WATCHDOG_ALIVE:${pid}\n`);
  }
}, 10000);

// ─── Handle signals ───
process.on("SIGTERM", () => {
  log(`[watchdog:${pid}] SIGTERM received, exiting.`);
  log(`[watchdog:${pid}] === EXIT 0 ===`);
  process.exit(0);
});

process.on("SIGINT", () => {
  log(`[watchdog:${pid}] SIGINT received, exiting.`);
  log(`[watchdog:${pid}] === EXIT 0 ===`);
  process.exit(0);
});

// ─── Global error handlers to diagnose crash ───
process.on("uncaughtException", (err) => {
  logErr(`[watchdog:${pid}] UNCAUGHT: ${err.stack || err.message}`);
  logErr(`[watchdog:${pid}] === EXIT 1 ===`);
  process.exit(1);
});

process.on("unhandledRejection", (reason) => {
  logErr(`[watchdog:${pid}] UNHANDLED REJECTION: ${reason}`);
  logErr(`[watchdog:${pid}] === EXIT 1 ===`);
  process.exit(1);
});
