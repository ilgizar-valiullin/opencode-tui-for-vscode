import * as vscode from "vscode";
import { serverManager } from "./opencodeServer";

export class OpenCodeWebviewProvider {
  private panel_: vscode.WebviewPanel | null = null;
  private extensionUri_: vscode.Uri;

  constructor(extensionUri: vscode.Uri) {
    this.extensionUri_ = extensionUri;
  }

  async open(): Promise<void> {
    if (this.panel_) { this.panel_.reveal(); return; }

    this.panel_ = vscode.window.createWebviewPanel(
      "opencode-tui", "OpenCode TUI", vscode.ViewColumn.Beside,
      { enableScripts: true, retainContextWhenHidden: true }
    );

    this.panel_.webview.html = this.html(this.panel_.webview);
    this.panel_.webview.onDidReceiveMessage((msg) => this.handle(msg));
    this.panel_.onDidDispose(() => {
      this.panel_ = null;
      serverManager.stop().catch(() => {});
    });
  }

  private async handle(msg: Record<string, unknown>): Promise<void> {
    if (msg.type === "ready") {
      const config = vscode.workspace.getConfiguration("opencode-tui-unofficial");
      const openCodePath = config.get<string>("opencodePath", "opencode");
      try {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        await serverManager.start(openCodePath, undefined, workspaceFolder);
      } catch (err: any) {
        this.panel_?.webview.postMessage({
          type: "terminalData",
          data: `\r\n\x1b[31mFailed to start OpenCode: ${err?.message ?? err}\x1b[0m\r\n`,
        });
        return;
      }
      serverManager.onStdout((data) => {
        this.panel_?.webview.postMessage({ type: "terminalData", data });
      });
    }
    if (msg.type === "resize") {
      serverManager.resizePty((msg as any).cols, (msg as any).rows);
    }
    if (msg.type === "textInput") {
      serverManager.writeToStdin(msg.data as string);
    }
  }

  private html(webview: vscode.Webview): string {
    const scriptUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri_, "dist", "webview.js")
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.extensionUri_, "dist", "webview.css")
    );
    const nonce = getNonce();

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
