import * as path from "path";
import * as vscode from "vscode";
import { OpenCodeServerManager } from "../opencodeServer";

const ENTER_DELAY_MS = 150;

const BINARY_EXTS = new Set([
  "png", "jpg", "jpeg", "gif", "webp", "bmp", "ico", "svg",
  "pdf",
]);

function isBinaryFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase().replace(".", "");
  return BINARY_EXTS.has(ext);
}

async function typeAndSubmit(server: OpenCodeServerManager, text: string): Promise<void> {
  server.writeToStdin(text);
  await new Promise((r) => setTimeout(r, ENTER_DELAY_MS));
  server.writeToStdin("\r");
}

async function pasteInPlace(server: OpenCodeServerManager, text: string): Promise<void> {
  server.writeToStdin(`\x1b[200~${text}\x1b[201~\n`);
}

async function getRelativePath(server: OpenCodeServerManager, filePath: string): Promise<string | null> {
  const cwd = server.cwd;
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

export async function attachFile(uri: vscode.Uri, server: OpenCodeServerManager): Promise<void> {
  if (!server.isRunning()) {
    vscode.window.showErrorMessage("OpenCode server is not running");
    return;
  }
  const absPath = uri.fsPath;
  if (isBinaryFile(absPath)) {
    await pasteInPlace(server, absPath);
    return;
  }
  const rel = await getRelativePath(server, absPath);
  if (rel === null) return;
  await typeAndSubmit(server, `@${rel}`);
}

export async function attachSelection(server: OpenCodeServerManager): Promise<void> {
  if (!server.isRunning()) {
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
  const rel = await getRelativePath(server, filePath);
  if (rel === null) return;

  if (sel.isEmpty) {
    await typeAndSubmit(server, `@${rel}`);
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

  server.writeToStdin(`\x1b[200~${formatted}\x1b[201~`);
}
