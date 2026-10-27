import * as vscode from "vscode";
import type { EditorContext } from "./mcp-server";

export const vscodeEditorState: () => EditorContext = () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return {};

  const result: EditorContext = {
    uri: editor.document.uri.toString(),
  };

  const sel = editor.selection;
  result.selection = {
    start: { line: sel.start.line, column: sel.start.character },
    end: { line: sel.end.line, column: sel.end.character },
    // Empty when the cursor is collapsed: opencode treats a collapsed range
    // as "user opened the file" and a non-empty range as the selection.
    text: sel.isEmpty ? "" : editor.document.getText(sel),
  };

  return result;
};
