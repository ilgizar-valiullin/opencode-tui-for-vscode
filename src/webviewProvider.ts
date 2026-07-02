import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { serverManager } from "./opencodeServer";

function extractLeaderChords(configDir: string, chords: Set<string>): void {
  const tuiPath = path.join(configDir, "tui.json");
  try {
    if (!fs.existsSync(tuiPath)) return;
    const raw = fs.readFileSync(tuiPath, "utf-8");
    const config = JSON.parse(raw);
    const keybinds = config?.keybinds;
    if (!keybinds || typeof keybinds !== "object") return;

    const bindings = Object.values(keybinds).flatMap((v: any): string[] => {
      if (typeof v === "string") return v.split(",").map((s: string) => s.trim()).filter(Boolean);
      if (Array.isArray(v)) return v.flatMap((x: any) => typeof x === "string" ? x.split(",").map((s: string) => s.trim()).filter(Boolean) : []);
      if (v && typeof v === "object" && typeof v.key === "string") return [v.key];
      return [];
    });

    for (const binding of bindings) {
      const match = binding.match(/^<leader>(\w+)$/i);
      if (match) chords.add(match[1].toLowerCase());
    }
  } catch {
    // Ignore read/parse errors
  }
}

function readLeaderChords(): string[] {
  const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
  const configured = config.get<string[]>("leaderChords", []);
  if (configured.length > 0) return [...new Set(configured.map((c) => c.toLowerCase()))].sort();

  const chords = new Set<string>();
  const checked = new Set<string>();

  const dirs: string[] = [];
  if (process.env.APPDATA) dirs.push(path.join(process.env.APPDATA, "opencode"));
  if (process.env.XDG_CONFIG_HOME) dirs.push(path.join(process.env.XDG_CONFIG_HOME, "opencode"));
  if (process.env.HOME) {
    dirs.push(path.join(process.env.HOME, ".config", "opencode"));
    dirs.push(path.join(process.env.HOME, ".opencode"));
  }
  if (process.env.USERPROFILE) dirs.push(path.join(process.env.USERPROFILE, ".opencode"));

  for (const dir of dirs) {
    const norm = path.resolve(dir);
    if (checked.has(norm)) continue;
    checked.add(norm);
    extractLeaderChords(norm, chords);
  }

  if (chords.size > 0) return Array.from(chords).sort();
  return ["n","l","c","x","g","m","a","e","t","s","b","h","y","u","r","q"];
}

export class OpenCodeWebviewProvider implements vscode.WebviewViewProvider {
  private view_: vscode.WebviewView | null = null;
  private panel_: vscode.WebviewPanel | null = null;
  private extensionUri_: vscode.Uri;
  private serverStarted_ = false;
  private webviewFocused_ = false;
  private isTabOpen_ = false;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri_ = extensionUri;
  }

  get viewVisible(): boolean {
    return !!(this.view_?.visible || this.panel_);
  }

  toggleFocus(): void {
    if (this.webviewFocused_) {
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      return;
    }
    const wv = this.view_?.webview ?? this.panel_?.webview;
    if (this.view_?.visible) {
      this.view_?.show?.(false);
    } else if (this.panel_) {
      this.panel_.reveal(undefined, false);
    } else {
      vscode.commands.executeCommand("workbench.view.extension.opencode-tui");
    }
    if (wv) {
      wv.postMessage({ type: "focusTerminal" });
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view_ = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri_, 'dist')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => {
      this.handleMessage(webviewView.webview, msg).catch((e) => {
        console.error("[opencode] handleMessage error:", e?.message ?? e);
      });
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && webviewView.webview) {
        webviewView.webview.postMessage({ type: "resize" });
      }
    });
  }

  private async handleMessage(webview: vscode.Webview, msg: Record<string, unknown>): Promise<void> {
    if (msg.type === "ready" && !this.serverStarted_) {
      this.serverStarted_ = true;
      const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      const openCodePath = config.get<string>("opencodePath", "opencode");
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await serverManager.start(openCodePath, undefined, workspaceFolder);
      } catch (err: any) {
        const msg = err?.message ?? String(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Failed to start OpenCode: {0}", msg));
        webview.postMessage({
          type: "terminalData",
          data: `\r\n\x1b[31m${vscode.l10n.t("Failed to start OpenCode: {0}", msg)}\x1b[0m\r\n`,
        });
        return;
      }
      serverManager.onStdout((data) => {
        webview.postMessage({ type: "terminalData", data });
      });
      webview.postMessage({ type: "serverInfo", address: "localhost", port: serverManager.port, running: true });
    }
    if (msg.type === "restartServer") {
      const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      const openCodePath = config.get<string>("opencodePath", "opencode");
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await serverManager.stop();
      try {
        await serverManager.start(openCodePath, undefined, workspaceFolder);
        serverManager.onStdout((data) => {
          webview.postMessage({ type: "terminalData", data });
        });
        webview.postMessage({ type: "serverInfo", address: "localhost", port: serverManager.port, running: true });
      } catch (err: any) {
        const m = err?.message ?? String(err);
        webview.postMessage({ type: "serverInfo", address: "localhost", port: 0, running: false });
        vscode.window.showErrorMessage(vscode.l10n.t("Failed to restart: {0}", m));
      }
    }
    if (msg.type === "toggleServer") {
      if (serverManager.isRunning()) {
        await serverManager.stop();
        webview.postMessage({ type: "serverInfo", address: "localhost", port: 0, running: false });
      } else {
        const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
        const openCodePath = config.get<string>("opencodePath", "opencode");
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          await serverManager.start(openCodePath, undefined, workspaceFolder);
          serverManager.onStdout((data) => {
            webview.postMessage({ type: "terminalData", data });
          });
          webview.postMessage({ type: "serverInfo", address: "localhost", port: serverManager.port, running: true });
        } catch (err: any) {
          const m = err?.message ?? String(err);
          webview.postMessage({ type: "serverInfo", address: "localhost", port: 0, running: false });
          vscode.window.showErrorMessage(vscode.l10n.t("Failed to start: {0}", m));
        }
      }
    }
    if (msg.type === "clipboardPaste") {
      try {
        const text = await vscode.env.clipboard.readText();
        if (text) serverManager.writeToStdin(`\x1b[200~${text}\x1b[201~`);
      } catch (e: any) {
        console.error("[TUI] clipboardPaste ERROR", e?.message ?? e);
      }
    }
    if (msg.type === "resize") {
      const m = msg as { cols: number; rows: number };
      serverManager.resizePty(m.cols, m.rows);
    }
    if (msg.type === "selectAll") {
      try {
        if (serverManager.client) {
          await serverManager.client.executeTuiCommand("input_select_all");
        }
      } catch { /* fallback: send super+a CSI u sequence via stdin */ }
      serverManager.writeToStdin("\x1b[97;9u");
    }
    if (msg.type === "textInput") {
      serverManager.writeToStdin(msg.data as string);
    }
    if (msg.type === "focusChange") {
      this.webviewFocused_ = msg.focused as boolean;
    }
  }

  async openInTab(): Promise<void> {
    if (this.panel_) { this.panel_.reveal(); return; }

    this.panel_ = vscode.window.createWebviewPanel(
      "opencode-tui-tab", "OpenCode TUI", vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri_, 'dist')],
      },
    );

    this.panel_.webview.html = this.html(this.panel_.webview);
    this.panel_.webview.onDidReceiveMessage((msg) => {
      this.handleMessage(this.panel_!.webview, msg).catch((e) => {
        console.error("[opencode] handleMessage error:", e?.message ?? e);
      });
    });
    this.panel_.onDidDispose(() => { this.panel_ = null; });
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri_, "dist", "webview.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri_, "dist", "webview.css"),
    );
    const nonce = getNonce();
    const chords = readLeaderChords();
    const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
    const ctrlASelectAll = config.get<boolean>("ctrlASelectAll", true);

    return `<!DOCTYPE html>
<html><head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<meta http-equiv="Content-Security-Policy"
 content="default-src 'none';style-src 'unsafe-inline' ${webview.cspSource};script-src 'nonce-${nonce}' ${webview.cspSource};font-src ${webview.cspSource};">
<link rel="stylesheet" href="${styleUri}">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{height:100%;background:#0d1117;overflow:hidden}
#terminal{height:calc(100% - 22px);width:100%}
#statusbar{position:fixed;bottom:0;left:0;right:0;height:22px;background:#4a80c8;color:#fff;display:flex;align-items:center;padding:0 8px;font-size:12px;z-index:100;gap:6px}
#statusbar .addr-info{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
#statusbar button{background:transparent;border:1px solid rgba(255,255,255,0.3);color:#fff;padding:0 8px;cursor:pointer;font-size:11px;line-height:18px;border-radius:2px}
#statusbar button:hover{background:rgba(255,255,255,0.1)}
#statusbar button:active{background:rgba(255,255,255,0.2)}
#statusbar button:disabled{opacity:0.5;cursor:default}
</style>
</head><body>
<div id="terminal"></div>
<div id="statusbar"><span class="addr-info">Starting...</span><button id="restartBtn">Restart</button><button id="toggleBtn">Shutdown</button></div>
<script nonce="${nonce}">var __LEADER_CHORDS__=${JSON.stringify(chords)};var __CTRL_A_SELECT_ALL__=${ctrlASelectAll}</script>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body></html>`;
  }
}

function getNonce(): string {
  let t = "";
  const c = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  for (let i = 0; i < 32; i++) t += c.charAt(Math.floor(Math.random() * c.length));
  return t;
}
