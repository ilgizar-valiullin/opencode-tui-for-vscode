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
    } else if (this.view_?.visible) {
      this.view_?.show?.(true);
    } else if (this.panel_) {
      this.panel_.reveal(undefined, true);
      vscode.commands.executeCommand("workbench.action.focusActiveEditorGroup");
      this.panel_.reveal(undefined, true);
    } else {
      vscode.commands.executeCommand("workbench.view.extension.opencode-tui");
    }
  }

  resolveWebviewView(webviewView: vscode.WebviewView): void {
    this.view_ = webviewView;
    webviewView.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri_, 'dist')],
    };
    webviewView.webview.html = this.html(webviewView.webview);
    webviewView.webview.onDidReceiveMessage((msg) => this.handleMessage(webviewView.webview, msg));
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
    }
    if (msg.type === "resize") {
      const m = msg as { cols: number; rows: number };
      serverManager.resizePty(m.cols, m.rows);
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
      "opencode-tui-tab", "OpenCode TUI", vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true },
    );

    this.panel_.webview.html = this.html(this.panel_.webview);
    this.panel_.webview.onDidReceiveMessage((msg) => this.handleMessage(this.panel_!.webview, msg));
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
#terminal{height:100%;width:100%}
</style>
</head><body>
<div id="terminal"></div>
<script nonce="${nonce}">var __LEADER_CHORDS__=${JSON.stringify(chords)}</script>
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
