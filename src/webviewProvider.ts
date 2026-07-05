import * as vscode from "vscode";
import * as fs from "fs";
import * as path from "path";
import { OpenCodeServerManager } from "./opencodeServer";

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
  private sidebarServer_: OpenCodeServerManager | null = null;
  private tabServer_: OpenCodeServerManager | null = null;
  private activeServer_: OpenCodeServerManager | null = null;
  private sidebarServerStarted_ = false;
  private tabServerStarted_ = false;
  private webviewFocused_ = false;
  private mcpPort_ = 0;
  private mcpDisconnectCallback_: (() => void) | null = null;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri_ = extensionUri;
  }

  setMcpPort(port: number): void { this.mcpPort_ = port; }
  setMcpDisconnectCallback(cb: () => void): void { this.mcpDisconnectCallback_ = cb; }

  getActiveServer(): OpenCodeServerManager | null {
    return this.activeServer_ ?? this.sidebarServer_;
  }

  async stopAllServers(): Promise<void> {
    await this.sidebarServer_?.stop();
    await this.tabServer_?.stop();
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
      this.handleMessage(webviewView.webview, msg, true).catch((e) => {
        console.error("[opencode] handleMessage error:", e?.message ?? e);
      });
    });
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible && webviewView.webview) {
        webviewView.webview.postMessage({ type: "resize" });
      }
    });
  }

  private async handleMessage(webview: vscode.Webview, msg: Record<string, unknown>, isSidebar: boolean): Promise<void> {
    if (msg.type === "ready") {
      if (isSidebar && this.sidebarServerStarted_) return;
      if (!isSidebar && this.tabServerStarted_) return;

      if (isSidebar) {
        this.sidebarServerStarted_ = true;
        this.sidebarServer_ = new OpenCodeServerManager();
        if (this.mcpPort_) this.sidebarServer_.setMcpPort(this.mcpPort_);
        if (this.mcpDisconnectCallback_) this.sidebarServer_.onMcpClientDisconnect(this.mcpDisconnectCallback_);
      } else {
        this.tabServerStarted_ = true;
        this.tabServer_ = new OpenCodeServerManager();
        if (this.mcpPort_) this.tabServer_.setMcpPort(this.mcpPort_);
        if (this.mcpDisconnectCallback_) this.tabServer_.onMcpClientDisconnect(this.mcpDisconnectCallback_);
      }

      const server = isSidebar ? this.sidebarServer_ : this.tabServer_;
      const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      const openCodePath = config.get<string>("opencodePath", "opencode");
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await server!.start(openCodePath, undefined, workspaceFolder);
      } catch (err: any) {
        const errMsg = err?.message ?? String(err);
        vscode.window.showErrorMessage(vscode.l10n.t("Failed to start OpenCode: {0}", errMsg));
        webview.postMessage({
          type: "terminalData",
          data: `\r\n\x1b[31m${vscode.l10n.t("Failed to start OpenCode: {0}", errMsg)}\x1b[0m\r\n`,
        });
        return;
      }
      server!.onStdout((data: string) => {
        webview.postMessage({ type: "terminalData", data });
      });
      webview.postMessage({ type: "serverInfo", address: "localhost", port: server!.port, running: true });
      return;
    }

    const server = isSidebar ? this.sidebarServer_ : this.tabServer_;
    if (!server) return;

    if (msg.type === "restartServer") {
      const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      const openCodePath = config.get<string>("opencodePath", "opencode");
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      await server.stop();
      try {
        await server.start(openCodePath, undefined, workspaceFolder);
        server.onStdout((data: string) => {
          webview.postMessage({ type: "terminalData", data });
        });
        webview.postMessage({ type: "serverInfo", address: "localhost", port: server.port, running: true });
      } catch (err: any) {
        const m = err?.message ?? String(err);
        webview.postMessage({ type: "serverInfo", address: "localhost", port: 0, running: false });
        vscode.window.showErrorMessage(vscode.l10n.t("Failed to restart: {0}", m));
      }
    }
    if (msg.type === "toggleServer") {
      if (server.isRunning()) {
        await server.stop();
        webview.postMessage({ type: "serverInfo", address: "localhost", port: 0, running: false });
      } else {
        const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
        const openCodePath = config.get<string>("opencodePath", "opencode");
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        try {
          await server.start(openCodePath, undefined, workspaceFolder);
          server.onStdout((data: string) => {
            webview.postMessage({ type: "terminalData", data });
          });
          webview.postMessage({ type: "serverInfo", address: "localhost", port: server.port, running: true });
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
        if (text) server.writeToStdin(`\x1b[200~${text}\x1b[201~`);
      } catch (e: any) {
        console.error("[TUI] clipboardPaste ERROR", e?.message ?? e);
      }
    }
    if (msg.type === "resize") {
      const m = msg as { cols: number; rows: number };
      server.resizePty(m.cols, m.rows);
    }
    if (msg.type === "selectAll") {
      try {
        if (server.client) {
          await server.client.executeTuiCommand("input_select_all");
        }
      } catch { /* fallback: send super+a CSI u sequence via stdin */ }
      server.writeToStdin("\x1b[97;9u");
    }
    if (msg.type === "textInput") {
      server.writeToStdin(msg.data as string);
    }
    if (msg.type === "focusChange") {
      this.webviewFocused_ = msg.focused as boolean;
      if (this.webviewFocused_) {
        this.activeServer_ = server;
      }
    }
    if (msg.type === "openSettings") {
      const cfg = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      webview.postMessage({
        type: "settingsData",
        opencodePath: cfg.get<string>("opencodePath", "opencode"),
        serverPort: cfg.get<number>("serverPort", 0),
        leaderChords: cfg.get<string[]>("leaderChords", []),
        ctrlASelectAll: cfg.get<boolean>("ctrlASelectAll", true),
        enterSendsMessage: cfg.get<boolean>("enterSendsMessage", true),
        orphanCleanupStartupScan: cfg.get<boolean>("orphanCleanup.startupScan", true),
        orphanCleanupWatchdog: cfg.get<boolean>("orphanCleanup.watchdog", true),
      });
    }
    if (msg.type === "saveSettings") {
      const s = msg as Record<string, unknown>;
      const cfg = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      await cfg.update("opencodePath", s.opencodePath, vscode.ConfigurationTarget.Global);
      await cfg.update("serverPort", s.serverPort as number, vscode.ConfigurationTarget.Global);
      await cfg.update("leaderChords", s.leaderChords as string[], vscode.ConfigurationTarget.Global);
      await cfg.update("ctrlASelectAll", s.ctrlASelectAll as boolean, vscode.ConfigurationTarget.Global);
      await cfg.update("enterSendsMessage", s.enterSendsMessage as boolean, vscode.ConfigurationTarget.Global);
      await cfg.update("orphanCleanup.startupScan", s.orphanCleanupStartupScan as boolean, vscode.ConfigurationTarget.Global);
      await cfg.update("orphanCleanup.watchdog", s.orphanCleanupWatchdog as boolean, vscode.ConfigurationTarget.Global);
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
      this.handleMessage(this.panel_!.webview, msg, false).catch((e) => {
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
    const enterSendsMessage = config.get<boolean>("enterSendsMessage", true);

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
#settingsOverlay{display:none;position:fixed;top:0;left:0;right:0;bottom:22px;background:rgba(0,0,0,0.7);z-index:200;align-items:center;justify-content:center}
#settingsOverlay.open{display:flex}
#settingsPanel{background:#0d1117;border:1px solid #30363d;padding:0;width:100%;max-width:448px;max-height:80vh;overflow-y:auto;color:#c9d1d9;font-size:13px;font-family:'Cascadia Code','Fira Code','JetBrains Mono','Consolas',monospace;box-sizing:border-box}
#settingsPanel .settings-header{padding:14px 20px;font-size:14px;font-weight:600;color:#f0f6fc;border-bottom:1px solid #21262d;letter-spacing:0.5px}
#settingsPanel .section{padding:0 20px}
#settingsPanel .section-title{padding:16px 0 8px;font-size:11px;font-weight:600;color:#58a6ff;text-transform:uppercase;letter-spacing:1px;border-bottom:1px solid #21262d;margin:0 0 12px}
#settingsPanel .platform-badge{display:inline-block;background:#21262d;color:#8b949e;font-size:9px;font-weight:400;text-transform:none;letter-spacing:0;padding:1px 6px;border-radius:3px;margin-left:6px;vertical-align:middle}
#settingsPanel .checkbox-label input:disabled+.checkbox-visual{opacity:0.4;cursor:default}
#settingsPanel .checkbox-label input:disabled~span{opacity:0.5}
#settingsPanel .checkbox-label input:disabled:hover+.checkbox-visual{border-color:#30363d}
#settingsPanel .section-title:first-of-type{padding-top:16px}
#settingsPanel .field{margin-bottom:16px}
#settingsPanel .field label{display:block;margin-bottom:5px;color:#8b949e;font-size:12px;font-weight:400}
#settingsPanel .field .desc{color:#484f58;font-size:11px;margin-top:5px;line-height:1.45}
#settingsPanel .field input[type="text"],#settingsPanel .field input[type="number"]{width:100%;padding:7px 10px;background:#161b22;border:1px solid #30363d;color:#c9d1d9;font-size:13px;font-family:inherit;outline:none;box-sizing:border-box}
#settingsPanel .field input[type="text"]:focus,#settingsPanel .field input[type="number"]:focus{border-color:#58a6ff;box-shadow:0 0 0 1px #58a6ff}
#settingsPanel .field input::placeholder{color:#484f58}
#settingsPanel .checkbox-field{padding-top:2px}
#settingsPanel .checkbox-label{display:flex;align-items:center;gap:0;cursor:pointer;color:#c9d1d9;font-size:13px;user-select:none}
#settingsPanel .checkbox-label input[type="checkbox"]{position:absolute;opacity:0;width:0;height:0}
#settingsPanel .checkbox-visual{display:inline-flex;align-items:center;justify-content:center;width:32px;height:20px;margin-right:8px;font-size:11px;line-height:1;color:#8b949e;background:#161b22;border:1px solid #30363d;flex-shrink:0}
#settingsPanel .checkbox-label input:checked+.checkbox-visual{color:#3fb950;border-color:#238636}
#settingsPanel .checkbox-label input:focus-visible+.checkbox-visual{border-color:#58a6ff;box-shadow:0 0 0 1px #58a6ff}
#settingsPanel .checkbox-label:hover .checkbox-visual{border-color:#58a6ff}
#settingsPanel .btn-row{display:flex;gap:8px;justify-content:flex-end;padding:14px 20px 12px;border-top:1px solid #21262d;margin-top:4px}
#settingsPanel .btn-row button{padding:5px 14px;border:1px solid #30363d;cursor:pointer;font-size:12px;font-family:inherit}
#settingsPanel .btn-row .btn-primary{background:#238636;color:#fff;border-color:#238636}
#settingsPanel .btn-row .btn-primary:hover{background:#2ea043}
#settingsPanel .btn-row .btn-primary:active{background:#196c2c}
#settingsPanel .btn-row .btn-secondary{background:transparent;color:#c9d1d9}
#settingsPanel .btn-row .btn-secondary:hover{background:#21262d}
</style>
</head><body>
<div id="terminal"></div>
<div id="statusbar"><span class="addr-info">Starting...</span><button id="restartBtn">Restart</button><button id="toggleBtn">Shutdown</button><button id="settingsBtn">&#9881;</button></div>
<div id="settingsOverlay"><div id="settingsPanel">
<div class="settings-header">${vscode.l10n.t("Settings")}</div>
<div class="section">
<div class="section-title">${vscode.l10n.t("Server")}</div>
<div class="field"><label for="setOpenCodePath">${vscode.l10n.t("OpenCode Path")}</label><input type="text" id="setOpenCodePath" /><div class="desc">${vscode.l10n.t("Path to opencode executable, e.g. 'opencode' or full path to binary")}</div></div>
<div class="field"><label for="setServerPort">${vscode.l10n.t("Server Port")}</label><input type="number" id="setServerPort" /><div class="desc">${vscode.l10n.t("Port for opencode REST API. 0 = auto (random free port on each start)")}</div></div>
</div>
<div class="section">
<div class="section-title">${vscode.l10n.t("Input")}</div>
<div class="field"><label for="setLeaderChords">${vscode.l10n.t("Leader Chords")}</label><input type="text" id="setLeaderChords" placeholder="n,l,c,x,g,m,..." /><div class="desc">${vscode.l10n.t("Key chords for leader mode (Ctrl+X + letter). Comma-separated, e.g. n,l,c,x,g,m")}</div></div>
<div class="field checkbox-field"><label class="checkbox-label"><input type="checkbox" id="setCtrlASelectAll" /><span class="checkbox-visual">&#x2713;</span>${vscode.l10n.t("Ctrl+A Select All (fix)")}</label><div class="desc" style="margin-left:40px"><div>${vscode.l10n.t("When ON: Ctrl+A selects all text in terminal")}</div><div>${vscode.l10n.t("When OFF: Ctrl+A goes to beginning of line like in bash")}</div></div></div>
<div class="field checkbox-field"><label class="checkbox-label"><input type="checkbox" id="setEnterSendsMessage" /><span class="checkbox-visual">&#x2713;</span>${vscode.l10n.t("Enter sends message")}</label><div class="desc" style="margin-left:40px"><div>${vscode.l10n.t("When ON: Enter=send, Shift+Enter=newline")}</div><div>${vscode.l10n.t("When OFF: Enter=newline, Shift+Enter=send")}</div></div></div>
</div>
<div class="section">
<div class="section-title">${vscode.l10n.t("Orphan Cleanup")}</div>
<div class="field checkbox-field"><label class="checkbox-label"><input type="checkbox" id="setOrphanStartupScan" /><span class="checkbox-visual">&#x2713;</span>${vscode.l10n.t("WMI scan on startup")}</label><div class="desc" style="margin-left:40px">${vscode.l10n.t("Scan for orphan opencode processes when extension activates")}</div></div>
<div class="field checkbox-field"><label class="checkbox-label"><input type="checkbox" id="setOrphanWatchdog" /><span class="checkbox-visual">&#x2713;</span>${vscode.l10n.t("Watchdog process")}</label><div class="desc" style="margin-left:40px">${vscode.l10n.t("Detached process that monitors extension host and cleans orphans on crash/kill")}</div></div>
</div>
<div class="btn-row"><button class="btn-secondary" id="settingsCancelBtn">${vscode.l10n.t("Cancel")}</button><button class="btn-primary" id="settingsSaveBtn">${vscode.l10n.t("Save")}</button></div>
</div></div>
<script nonce="${nonce}">var __LEADER_CHORDS__=${JSON.stringify(chords)};var __CTRL_A_SELECT_ALL__=${ctrlASelectAll};var __ENTER_SENDS_MESSAGE__=${enterSendsMessage}</script>
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
