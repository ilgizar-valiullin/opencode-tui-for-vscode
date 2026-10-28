import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import * as os from "os";
import { OpenCodeWebviewProvider } from "./webviewProvider";
import { OpenCodeServerManager } from "./opencodeServer";
import { attachFile, attachSelection } from "./commands/attachFile";
import { createMcpServer } from "./mcp-server";
import { vscodeEditorState } from "./vscode-editor-state";
import type { IdeMentionParams } from "./ideWs";

let provider: OpenCodeWebviewProvider | null = null;
/** v2-native file attach, set once the MCP/IDE bridge is up (null until then). */
let mcpMention: ((params: IdeMentionParams) => void) | null = null;

export async function activate(context: vscode.ExtensionContext) {
  console.log("[opencode] activate start");

  // ─── Orphan cleanup settings (async, non-blocking) ───
  const cfg = vscode.workspace.getConfiguration("opencode-tui-unofficial");
  OpenCodeServerManager.watchdogEnabled = cfg.get<boolean>("orphanCleanup.watchdog", true);
  if (cfg.get<boolean>("orphanCleanup.startupScan", true)) {
    OpenCodeServerManager.startupCleanup().catch(() => {});
  }

  const origUhr = process.listeners("unhandledRejection");
  process.removeAllListeners("unhandledRejection");
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (
      msg.includes("fetch failed") ||
      msg.includes("sendResourceUpdated") ||
      msg.includes("stream") ||
      msg.includes("Cannot enqueue")
    ) {
      return;
    }
    for (const h of origUhr) h(reason, Promise.resolve());
  });

  provider = new OpenCodeWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider("opencode-tui.view", provider, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    vscode.commands.registerCommand("opencode-tui-unofficial.focusView", () => {
      vscode.commands.executeCommand("workbench.view.extension.opencode-tui");
    }),
    vscode.commands.registerCommand("opencode-tui-unofficial.openTerminal", () => { provider!.openInTab().catch(() => {}); }),
    vscode.commands.registerCommand("opencode-tui-unofficial.openTab", () => { provider!.openInTab().catch(() => {}); }),
    vscode.commands.registerCommand("opencode-tui-unofficial.toggleFocus", () => provider!.toggleFocus()),
    vscode.commands.registerCommand("opencode-tui-unofficial.stopServer", () => { provider!.stopAllServers().catch(() => {}); }),
    vscode.commands.registerCommand("opencode-tui-unofficial.attachFile", (uri: vscode.Uri) => { const s = provider!.getActiveServer(); if (s) attachFile(uri, s).catch(() => {}); }),
    vscode.commands.registerCommand("opencode-tui-unofficial.attachFileContext", () => { const s = provider!.getActiveServer(); if (s) attachSelection(s, mcpMention).catch(() => {}); }),
    vscode.commands.registerCommand("opencode-tui-unofficial.handlePaste", async () => {
      try {
        const text = await vscode.env.clipboard.readText();
        const s = provider!.getActiveServer();
        if (text && s) s.writeToStdin(`\x1b[200~${text}\x1b[201~`);
      } catch { /* ignore */ }
    }),
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "$(terminal) OpenCode";
  statusBar.command = "opencode-tui-unofficial.openTerminal";
  statusBar.show();
  context.subscriptions.push(statusBar);

  // --- MCP Server for IDE Context Awareness ---
  try {
    const authToken = crypto.randomUUID();
    const version = context.extension.packageJSON.version ?? "0.0.0";

    const mcpHandle = await createMcpServer(vscodeEditorState, version, authToken);
    mcpMention = (params) => { mcpHandle.mention(params); };

    // opencode's TUI discovers the IDE via `~/.claude/ide/*.lock`
    // (see `discoverEditorConnection` in opencode) and connects over
    // WebSocket; without this file the selection is never shared.
    const claudeIdeDir = path.join(os.homedir(), ".claude", "ide");
    fs.mkdirSync(claudeIdeDir, { recursive: true });
    const lockFilePath = path.join(claudeIdeDir, `${mcpHandle.port}.lock`);

    const lockContent = JSON.stringify({
      pid: process.pid,
      workspaceFolders: (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath),
      authToken,
      transport: "ws",
    });
    const tmpPath = lockFilePath + ".tmp";
    fs.writeFileSync(tmpPath, lockContent, { mode: 0o600 });
    fs.renameSync(tmpPath, lockFilePath);

    provider.setMcpPort(mcpHandle.port);
    provider.setEditorPort(mcpHandle.port);
    provider.setMcpDisconnectCallback(() => mcpHandle.sessionsClose().catch(() => {}));

    // VS Code diagnostics bridge + bundled opencode plugin (no repo pollution:
    // injected via env, see OpenCodeServerManager.setIdeBridge).
    const bridgePluginDir = path.join(__dirname, "vscode-bridge-plugin");
    if (fs.existsSync(bridgePluginDir)) {
      provider.setIdeBridge(`http://127.0.0.1:${mcpHandle.port}`, authToken, bridgePluginDir);
    } else {
      console.warn(`[opencode] bridge plugin missing at ${bridgePluginDir}, diagnostics tool disabled`);
      provider.setIdeBridge(`http://127.0.0.1:${mcpHandle.port}`, authToken, "");
    }

    const EDITOR_NOTIFY_DEBOUNCE_MS = 150;
    let debounceTimer: ReturnType<typeof setTimeout> | undefined;
    function notifyDebounced() {
      if (debounceTimer) clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        mcpHandle.notifyContextChanged().catch(() => {});
      }, EDITOR_NOTIFY_DEBOUNCE_MS);
    }

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(() => notifyDebounced()),
      vscode.window.onDidChangeTextEditorSelection(() => notifyDebounced()),
      {
        dispose() {
          if (debounceTimer) clearTimeout(debounceTimer);
        },
      },
      {
        dispose() {
          mcpHandle.close().catch(() => {});
          try { fs.unlinkSync(lockFilePath); } catch {}
        },
      },
    );

    console.log(`[opencode] MCP server started on port ${mcpHandle.port}`);
  } catch (err) {
    console.error("[opencode] MCP server failed to start", err);
  }

  console.log("[opencode] activate done");
}

export function deactivate() {
  provider?.stopAllServers().catch(() => {});
  // Watchdog stays alive — it detects extension host exit via stdin pipe break,
  // waits 15s grace period, then cleans up orphan processes on its own.
}
