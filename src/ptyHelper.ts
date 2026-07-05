import { spawn as ptySpawn, IPty } from "node-pty";
import { createInterface } from "readline";
import { spawn as cpSpawn, spawnSync } from "child_process";
import { Readable, Writable } from "stream";

const rl = createInterface({ input: process.stdin });

let pty: IPty | null = null;
let cpChild: ReturnType<typeof cpSpawn> | null = null;

function fallbackSpawn(file: string, args: string[], cwd: string, env: Record<string, string>, cols: number, rows: number): IPty {
  cpChild = cpSpawn(file, args, {
    cwd, env, stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  let onDataCb: ((data: string) => void) | null = null;
  let onExitCb: ((r: { exitCode: number }) => void) | null = null;

  cpChild.stdout!.on("data", (chunk: Buffer) => {
    if (onDataCb) onDataCb(chunk.toString("utf8"));
  });

  cpChild.stderr!.on("data", (chunk: Buffer) => {
    if (onDataCb) onDataCb(chunk.toString("utf8"));
  });

  cpChild.on("exit", (code) => {
    if (onExitCb) onExitCb({ exitCode: code ?? -1 });
  });

  cpChild.on("error", (err) => {
    process.stderr.write("SPAWN_FALLBACK_ERROR: " + err.message + "\n");
    if (onExitCb) onExitCb({ exitCode: 1 });
  });

  return {
    pid: cpChild.pid ?? -1,
    onData(cb: (data: string) => void) { onDataCb = cb; },
    write(data: string) { cpChild?.stdin?.write(data); },
    resize(_cols: number, _rows: number) {},
    kill(signal?: string) { cpChild?.kill(signal as any); },
    onExit(cb: (r: { exitCode: number; signal?: number }) => void) { onExitCb = cb; },
  } as unknown as IPty;
}

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
      const preCheck = spawnSync(msg.path, ["--version"], {
        cwd, env, stdio: "pipe", timeout: 5000,
      });
      if (preCheck.error) {
        process.stderr.write("PRE_CHECK_ERROR: " + preCheck.error.message + "\n");
        process.exit(1);
        return;
      }
      if (preCheck.status !== 0) {
        process.stderr.write(
          "PRE_CHECK_BAD_STATUS: exit=" + preCheck.status + " stderr=" +
          (preCheck.stderr?.toString().trim() || "") + "\n"
        );
        process.exit(1);
        return;
      }

      try {
        pty = ptySpawn(msg.path, args, {
          name: "xterm-256color",
          cols: 80,
          rows: 24,
          cwd,
          env: env as { [k: string]: string },
          useConptyDll: true,
          conptyInheritCursor: false,
          handleFlowControl: false,
        });
      } catch (e) {
        process.stderr.write("PTY_SPAWN_FAILED: " + (e instanceof Error ? e.message : String(e)) + " - falling back to child_process.spawn\n");
        pty = fallbackSpawn(msg.path, args, cwd, env as Record<string, string>, 80, 24);
      }
    } catch (e: unknown) {
      const errMsg = e instanceof Error
        ? `${e.name}: ${e.message}` + (e.cause ? ` (cause: ${e.cause})` : "")
        : String(e);
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

  if (msg.type === "stdin" && msg.data) {
    if (pty) pty.write(msg.data);
    else if (cpChild?.stdin?.writable) cpChild.stdin.write(msg.data);
  }

  if (msg.type === "resize") {
    const { cols, rows } = msg as unknown as { cols: number; rows: number };
    if (pty) pty.resize(cols, rows);
  }

  if (msg.type === "kill") {
    if (pty) pty.kill();
    else if (cpChild) cpChild.kill();
    process.exit(0);
  }
});
