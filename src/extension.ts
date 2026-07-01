import * as vscode from "vscode";
import { serverManager } from "./opencodeServer";
import { OpenCodeWebviewProvider } from "./webviewProvider";

export function activate(context: vscode.ExtensionContext) {
  console.log("[opencode] activate start");

  const provider = new OpenCodeWebviewProvider(context.extensionUri);

  context.subscriptions.push(
    vscode.commands.registerCommand("opencode-tui-unofficial.openTerminal", () => provider.open()),
    vscode.commands.registerCommand("opencode-tui-unofficial.stopServer", () => serverManager.stop())
  );

  const statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.text = "$(terminal) OpenCode";
  statusBar.command = "opencode-tui-unofficial.openTerminal";
  statusBar.show();
  context.subscriptions.push(statusBar);

  console.log("[opencode] activate done");
}

export function deactivate() { serverManager.stop().catch(() => {}); }
