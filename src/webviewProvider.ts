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
    if (msg.type === "openSettings") {
      const cfg = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      webview.postMessage({
        type: "settingsData",
        opencodePath: cfg.get<string>("opencodePath", "opencode"),
        serverPort: cfg.get<number>("serverPort", 0),
        leaderChords: cfg.get<string[]>("leaderChords", []),
        ctrlASelectAll: cfg.get<boolean>("ctrlASelectAll", true),
      });
    }
    if (msg.type === "saveSettings") {
      const s = msg as Record<string, unknown>;
      const cfg = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      await cfg.update("opencodePath", s.opencodePath, vscode.ConfigurationTarget.Global);
      await cfg.update("serverPort", s.serverPort as number, vscode.ConfigurationTarget.Global);
      await cfg.update("leaderChords", s.leaderChords as string[], vscode.ConfigurationTarget.Global);
      await cfg.update("ctrlASelectAll", s.ctrlASelectAll as boolean, vscode.ConfigurationTarget.Global);
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
#settingsOverlay{display:none;position:fixed;top:0;left:0;right:0;bottom:22px;background:rgba(0,0,0,0.6);z-index:200;align-items:center;justify-content:center}
#settingsOverlay.open{display:flex}
#settingsPanel{background:#1c2333;border:1px solid #30363d;border-radius:6px;padding:20px;width:420px;max-height:80vh;overflow-y:auto;color:#c9d1d9;font-size:13px;font-family:system-ui,-apple-system,sans-serif}
#settingsPanel h2{margin:0 0 16px;font-size:16px;color:#f0f6fc}
#settingsPanel .field{margin-bottom:12px}
#settingsPanel label{display:block;margin-bottom:4px;color:#8b949e;font-size:12px}
#settingsPanel .desc{color:#6e7681;font-size:11px;margin:2px 0 6px;line-height:1.4}
#settingsPanel code{color:#8b949e;font-size:inherit}
#settingsPanel input[type="text"],#settingsPanel input[type="number"]{width:100%;padding:6px 8px;background:#0d1117;border:1px solid #30363d;border-radius:4px;color:#c9d1d9;font-size:13px;box-sizing:border-box}
#settingsPanel input[type="checkbox"]{margin-right:6px}
#settingsPanel .checkbox-row{display:flex;align-items:center;gap:6px;margin-bottom:12px}
#settingsPanel .btn-row{display:flex;gap:8px;justify-content:flex-end;margin-top:16px}
#settingsPanel .btn-row button{padding:6px 16px;border:1px solid #30363d;border-radius:4px;cursor:pointer;font-size:12px}
#settingsPanel .btn-row .btn-primary{background:#238636;color:#fff;border-color:#238636}
#settingsPanel .btn-row .btn-primary:hover{background:#2ea043}
#settingsPanel .btn-row .btn-secondary{background:transparent;color:#c9d1d9}
#settingsPanel .btn-row .btn-secondary:hover{background:rgba(255,255,255,0.1)}
</style>
</head><body>
<div id="terminal"></div>
<div id="statusbar"><span class="addr-info">Starting...</span><button id="restartBtn">Restart</button><button id="toggleBtn">Shutdown</button><button id="settingsBtn">&#9881;</button></div>
<div id="settingsOverlay"><div id="settingsPanel"><h2>${vscode.l10n.t("Settings")}</h2><div class="field"><label for="setOpenCodePath">${vscode.l10n.t("OpenCode Path")}</label><div class="desc">${vscode.l10n.t("Path to opencode executable, e.g. 'opencode' or full path to binary")}</div><input type="text" id="setOpenCodePath" /></div><div class="field"><label for="setServerPort">${vscode.l10n.t("Server Port")}</label><div class="desc">${vscode.l10n.t("Port for opencode REST API. 0 = auto (random free port on each start)")}</div><input type="number" id="setServerPort" /></div><div class="field"><label for="setLeaderChords">${vscode.l10n.t("Leader Chords")}</label><div class="desc">${vscode.l10n.t("Key chords for leader mode (Ctrl+X + letter). Comma-separated, e.g. n,l,c,x,g,m")}</div><input type="text" id="setLeaderChords" placeholder="n,l,c,x,g,m,..." /></div><div class="checkbox-row"><input type="checkbox" id="setCtrlASelectAll" /><label for="setCtrlASelectAll" style="margin:0">${vscode.l10n.t("Ctrl+A Select All (fix)")}</label></div><div class="btn-row"><button class="btn-secondary" id="settingsCancelBtn">${vscode.l10n.t("Cancel")}</button><button class="btn-primary" id="settingsSaveBtn">${vscode.l10n.t("Save")}</button></div></div></div>
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
