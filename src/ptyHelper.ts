/**
 * PTY helper — runs under system Node.js (not Electron).
 * Spawns opencode with node-pty for proper terminal emulation.
 *
 * Protocol:
 *   Input (stdin, JSON-line):
 *     → {"type":"spawn","path":"opencode","port":1234}
 *     → {"type":"stdin","data":"text\n"}
 *     → {"type":"resize","cols":N,"rows":M}
 *     → {"type":"kill"}
 *
 *   Output (stdout, null-delimited frames):
 *     ← D<raw_stdout_data>\0
 *     ← R{"pid":12345}\0
 *     ← E{"code":0}\0
 */
import { spawn } from "node-pty";
import { createInterface } from "readline";

const rl = createInterface({ input: process.stdin });

let pty: ReturnType<typeof spawn> | null = null;

rl.on("line", (line: string) => {
  let msg: { type: string; path?: string; port?: number; data?: string };
  try { msg = JSON.parse(line); } catch { return; }

  if (msg.type === "spawn" && msg.path && msg.port) {
    const cwd = (msg as any).cwd || process.env.USERPROFILE || process.cwd();
    const args = ["--port", String(msg.port)];

    const env = { ...process.env };
    delete env.WT_SESSION;
    delete env.WT_PROFILE_ID;
    delete env.TERM_PROGRAM;
    delete env.TERM_PROGRAM_VERSION;
    delete env.COLORTERM;
    delete env.VSCODE_INJECTION;
    delete env.VSCODE_IPC_HOOK;
    delete env.VSCODE_GIT_IPC_HANDLE;

    const mcpPort = (msg as any).mcpPort;
    if (mcpPort) env.OPENCODE_MCP_PORT = String(mcpPort);

    try {
      pty = spawn(msg.path, args, {
        name: "xterm-256color",
        cols: 80,
        rows: 24,
        cwd,
        env: env as { [k: string]: string },
        useConptyDll: true,
        conptyInheritCursor: false,
        handleFlowControl: false,
      });
    } catch (e: unknown) {
      const errMsg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
      process.stderr.write("SPAWN_ERROR: " + errMsg + "\n");
      process.exit(1);
    }

    process.stdout.write("R" + JSON.stringify({ pid: pty.pid }) + "\0");

    pty.onData((data: string) => {
      process.stdout.write("D" + data + "\0");
    });

    pty.onExit(({ exitCode }) => {
      process.stdout.write("E" + JSON.stringify({ code: exitCode }) + "\0");
      process.exit(0);
    });
  }

  if (msg.type === "stdin" && msg.data && pty) {
    pty.write(msg.data);
  }

  if (msg.type === "resize" && pty) {
    const { cols, rows } = msg as unknown as { cols: number; rows: number };
    pty.resize(cols, rows);
  }

  if (msg.type === "kill" && pty) {
    pty.kill();
    process.exit(0);
  }
});
