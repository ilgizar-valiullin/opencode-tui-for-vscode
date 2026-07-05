import { execSync } from "child_process";

const isWin = process.platform === "win32";

export async function runCleanup(): Promise<number> {
  console.log("[opencode] [cleanup] Scanning for orphan processes...");

  try {
    let out: string;
    if (isWin) {
      const cmd = `powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process|?{$_.Name-match'node|opencode|mcp|ptyhelper' -and $_.ParentProcessId-ne 0 -and !(Get-Process -Id $_.ParentProcessId -EA 0)};$p|%{Stop-Process -Id $_.ProcessId -Force|Out-Null};$p.Count"`;
      out = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 10000, encoding: "utf8", windowsHide: true }).trim();
    } else {
      const cmd = `ps -eo pid,ppid,args | awk '$2==1 && /node|opencode|mcp|ptyhelper/ {system("kill " $1 " 2>/dev/null"); print}' | wc -l`;
      out = execSync(cmd, { stdio: ["ignore", "pipe", "pipe"], timeout: 10000, encoding: "utf8" }).trim();
    }
    const count = parseInt(out, 10) || 0;
    console.log(`[opencode] [cleanup] Result: ${count}`);
    return count;
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    console.log(`[opencode] [cleanup] Error: ${msg.substring(0, 512)}`);
    return 0;
  }
}
