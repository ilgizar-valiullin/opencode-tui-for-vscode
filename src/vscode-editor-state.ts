import * as vscode from "vscode";
import type { EditorContext } from "./mcp-server";

export const vscodeEditorState: () => EditorContext = () => {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return {};

  const result: EditorContext = {
    uri: editor.document.uri.toString(),
  };

  const sel = editor.selection;
  if (!sel.isEmpty) {
    result.selection = {
      start: { line: sel.start.line, column: sel.start.character },
      end: { line: sel.end.line, column: sel.end.character },
      text: editor.document.getText(sel),
    };
  }

  return result;
};
