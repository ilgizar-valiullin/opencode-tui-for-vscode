import * as path from "path";
import * as vscode from "vscode";
import { OpenCodeServerManager } from "../opencodeServer";
import type { IdeMentionParams } from "../ideWs";

/**
 * v2-native file attach: IDE WebSocket `at_mentioned`. Inserts a structured
 * attachment into the TUI prompt draft — no typing races, no focus tricks.
 * Broadcast to every TUI connected to the IDE bridge (same as selection).
 */
export type MentionFn = (params: IdeMentionParams) => void;

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
  // Full (absolute) path: insert only, no Enter — the user confirms manually.
  // Trailing space separates the path from whatever the user types next.
  server.writeToStdin(`\x1b[200~${text}\x1b[201~ `);
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
  // Workspace file: `@rel` + Enter (auto-confirm the picker). A whole file
  // cannot go through `at_mentioned`: the TUI always sets `?start=N`
  // (upstream anomalyco/opencode#58033), i.e. N..EOF, never the whole file.
  await typeAndSubmit(server, `@${rel}`);
}

export async function attachSelection(server: OpenCodeServerManager, mention?: MentionFn | null): Promise<void> {
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

  const startLine = sel.start.line + 1;
  let endLine = sel.end.line + 1;
  if (sel.end.character === 0 && sel.end.line > sel.start.line) {
    endLine--;
  }

  if (!sel.isEmpty && endLine > startLine && mention) {
    // v2-native: structured range attachment, no PTY races. Lines are 1-based.
    mention({ filePath, lineStart: startLine, lineEnd: endLine });
    return;
  }

  const rel = await getRelativePath(server, filePath);
  if (rel === null) return;

  // Workspace file: `@rel` / `@rel#Lline` + Enter (auto-confirm the picker).
  // Single-line selections and collapsed cursors cannot go through
  // `at_mentioned`: upstream drops `end` when it equals `start` (N..EOF,
  // anomalyco/opencode#58033).
  const ref = sel.isEmpty ? `@${rel}` : `@${rel}#L${startLine}`;
  await typeAndSubmit(server, ref);
}
