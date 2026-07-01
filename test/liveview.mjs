import { spawn } from "node-pty";
import { existsSync } from "fs";

const PORT = Math.floor(Math.random() * (65535 - 16384 + 1)) + 16384;
const CWD = process.argv[2] || process.cwd();

let ocPath = "opencode";
if (process.platform === "win32" && process.env.LOCALAPPDATA) {
  const local = `${process.env.LOCALAPPDATA}\\OpenCode\\opencode.exe`;
  if (existsSync(local)) ocPath = local;
}

process.stdout.write("\x1b[2J\x1b[H");
console.log(`LiveView | port=${PORT} cwd=${CWD}`);
console.log("─".repeat(60));

const cleanEnv = { ...process.env };
delete cleanEnv.WT_SESSION;
delete cleanEnv.WT_PROFILE_ID;
delete cleanEnv.TERM_PROGRAM;
delete cleanEnv.TERM_PROGRAM_VERSION;
delete cleanEnv.COLORTERM;
delete cleanEnv.VSCODE_INJECTION;
delete cleanEnv.VSCODE_IPC_HOOK;
delete cleanEnv.VSCODE_GIT_IPC_HANDLE;

const pty = spawn(ocPath, ["--port", String(PORT)], {
  name: "xterm-256color",
  cols: process.stdout.columns || 80,
  rows: process.stdout.rows || 24,
  cwd: CWD,
  env: cleanEnv,
  useConptyDll: true,
  conptyInheritCursor: false,
  handleFlowControl: false,
});

pty.onData((data) => {
  process.stdout.write(data);
});

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (String(chunk) === "\x03") { pty.kill(); process.exit(0); }
  pty.write(String(chunk));
});

process.stdout.on("resize", () => {
  try { pty.resize(process.stdout.columns, process.stdout.rows); } catch { /* */ }
});

pty.onExit(({ exitCode }) => { process.exit(exitCode); });
