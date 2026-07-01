import * as path from "path";
import * as vscode from "vscode";
import { serverManager } from "../opencodeServer";

const ENTER_DELAY_MS = 150;

async function typeAndSubmit(text: string): Promise<void> {
  serverManager.writeToStdin(text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  serverManager.writeToStdin("\r");
}

async function getRelativePath(filePath: string): Promise<string | null> {
  const cwd = serverManager.cwd;
  if (!cwd) {
    vscode.window.showErrorMessage("Server working directory unknown");
    return null;
  }
  const rel = path.relative(cwd, filePath).replace(/\\/g, "/");
  if (rel.startsWith("..")) {
    vscode.window.showErrorMessage("File is outside the server workspace");
    return null;
  }
  return rel;
}

export async function attachFile(uri: vscode.Uri): Promise<void> {
  if (!serverManager.isRunning()) {
    vscode.window.showErrorMessage("OpenCode server is not running");
    return;
  }
  const rel = await getRelativePath(uri.fsPath);
  if (rel === null) return;
  await typeAndSubmit(`@${rel}`);
}

export async function attachSelection(): Promise<void> {
  if (!serverManager.isRunning()) {
    vscode.window.showErrorMessage("OpenCode server is not running");
    return;
  }
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor");
    return;
  }
  const document = editor.document;
  const sel = editor.selection;
  const filePath = document.uri.fsPath;
  const rel = await getRelativePath(filePath);
  if (rel === null) return;

  if (sel.isEmpty) {
    await typeAndSubmit(`@${rel}`);
    return;
  }

  const startLine = sel.start.line + 1;
  let endLine = sel.end.line + 1;
  let lastLineIndex = sel.end.line;
  if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    lastLineIndex--;
    endLine--;
  }
  const fullRange = new vscode.Range(
    sel.start.line, 0,
    lastLineIndex, document.lineAt(lastLineIndex).text.length,
  );
  const selectedText = document.getText(fullRange);
  const languageId = document.languageId;

  const formatted = [
    `file:${rel} (lines ${startLine}-${endLine})`,
    `\`\`\`${languageId}`,
    selectedText,
    "```",
    "",
  ].join("\n");

  serverManager.writeToStdin(`\x1b[200~${formatted}\x1b[201~`);
}
