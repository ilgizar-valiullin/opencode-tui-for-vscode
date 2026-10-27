import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

export type BridgeSeverity = "error" | "warning" | "information" | "hint";

export interface BridgeRange {
  start: { line: number; column: number };
  end: { line: number; column: number };
}

export interface BridgeDiagnosticDto {
  severity: BridgeSeverity;
  range: BridgeRange;
  message: string;
  source?: string;
  code?: string;
}

export interface DiagnosticsSnapshot {
  file: string;
  uri: string;
  exists: boolean;
  isDirty: boolean;
  version?: number;
  mtimeMs?: number;
  updatedAt: number;
  stale: boolean;
  count: number;
  diagnostics: BridgeDiagnosticDto[];
  content?: string;
  contentTruncated?: boolean;
}

export interface DiagnosticsTracker {
  updatedAtFor(fsPath: string): number;
  waitForUpdate(fsPath: string, freshAfter: number, waitMs: number): Promise<void>;
  dispose(): void;
}

const MAX_DIAGNOSTICS = 100;
const MAX_CONTENT_CHARS = 50000;
const MAX_WAIT_MS = 10000;

export function normalizeFsKey(fsPath: string): string {
  const normalized = path.normalize(fsPath);
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

export function resolveFileParam(
  raw: string | null | undefined,
  workspaceFolders: readonly vscode.WorkspaceFolder[] | undefined,
): { fsPath: string; uri: vscode.Uri } | { error: string } {
  if (!raw || raw.trim().length === 0) {
    return { error: "Missing 'file' query parameter" };
  }
  const trimmed = raw.trim();
  try {
    if (/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
      const uri = vscode.Uri.parse(trimmed);
      if (uri.scheme !== "file") {
        return { error: `Only file:// URIs are supported (got '${uri.scheme}:')` };
      }
      return { fsPath: uri.fsPath, uri };
    }
    const abs = path.isAbsolute(trimmed)
      ? path.normalize(trimmed)
      : workspaceFolders?.[0]
        ? path.join(workspaceFolders[0].uri.fsPath, trimmed)
        : null;
    if (!abs) {
      return { error: "Relative path requires an open workspace folder" };
    }
    return { fsPath: abs, uri: vscode.Uri.file(abs) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return { error: `Invalid file parameter: ${msg.substring(0, 200)}` };
  }
}

function severityName(s: vscode.DiagnosticSeverity): BridgeSeverity {
  switch (s) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "information";
    default:
      return "hint";
  }
}

function codeToString(code: vscode.Diagnostic["code"]): string | undefined {
  if (typeof code === "string" || typeof code === "number") {
    return String(code);
  }
  if (code && typeof code === "object" && "value" in code) {
    const v = (code as { value: unknown }).value;
    if (typeof v === "string" || typeof v === "number") {
      return String(v);
    }
  }
  return undefined;
}

export function diagnosticToDto(d: vscode.Diagnostic): BridgeDiagnosticDto {
  const dto: BridgeDiagnosticDto = {
    severity: severityName(d.severity),
    range: {
      start: { line: d.range.start.line, column: d.range.start.character },
      end: { line: d.range.end.line, column: d.range.end.character },
    },
    message: d.message,
  };
  if (d.source) {
    dto.source = d.source;
  }
  const code = codeToString(d.code);
  if (code !== undefined) {
    dto.code = code;
  }
  return dto;
}

export function snapshotForFile(
  fsPath: string,
  uri: vscode.Uri,
  opts: { includeContent: boolean; updatedAt: number; freshAfter: number },
): DiagnosticsSnapshot {
  const key = normalizeFsKey(fsPath);
  const live = vscode.languages.getDiagnostics(uri);
  const diagnostics = live.slice(0, MAX_DIAGNOSTICS).map(diagnosticToDto);

  let exists = false;
  let mtimeMs: number | undefined;
  try {
    const st = fs.statSync(fsPath);
    exists = true;
    mtimeMs = st.mtimeMs;
  } catch {
    exists = false;
  }

  const doc = vscode.workspace.textDocuments.find(
    (d) => d.uri.scheme === "file" && normalizeFsKey(d.uri.fsPath) === key,
  );

  const snap: DiagnosticsSnapshot = {
    file: fsPath,
    uri: uri.toString(),
    exists,
    isDirty: doc?.isDirty ?? false,
    updatedAt: opts.updatedAt,
    stale: opts.freshAfter > 0 && opts.updatedAt <= opts.freshAfter,
    count: live.length,
    diagnostics,
  };
  if (mtimeMs !== undefined) {
    snap.mtimeMs = mtimeMs;
  }
  if (doc) {
    snap.version = doc.version;
    if (opts.includeContent) {
      const text = doc.getText();
      if (text.length > MAX_CONTENT_CHARS) {
        snap.content = text.slice(0, MAX_CONTENT_CHARS);
        snap.contentTruncated = true;
      } else {
        snap.content = text;
      }
    }
  }
  return snap;
}

export function clampWaitMs(raw: string | null): number {
  const n = Math.floor(Number(raw) || 0);
  return Math.max(0, Math.min(MAX_WAIT_MS, n));
}

export function createDiagnosticsTracker(): DiagnosticsTracker {
  const updatedAt = new Map<string, number>();
  const waiters = new Map<string, Set<() => void>>();

  const sub = vscode.languages.onDidChangeDiagnostics((e) => {
    const now = Date.now();
    for (const uri of e.uris) {
      if (uri.scheme !== "file") {
        continue;
      }
      const key = normalizeFsKey(uri.fsPath);
      updatedAt.set(key, now);
      const set = waiters.get(key);
      if (set) {
        waiters.delete(key);
        for (const resolve of set) {
          resolve();
        }
      }
    }
  });

  return {
    updatedAtFor(fsPath: string): number {
      return updatedAt.get(normalizeFsKey(fsPath)) ?? 0;
    },
    waitForUpdate(fsPath: string, freshAfter: number, waitMs: number): Promise<void> {
      const key = normalizeFsKey(fsPath);
      if ((updatedAt.get(key) ?? 0) > freshAfter) {
        return Promise.resolve();
      }
      const bounded = Math.max(0, Math.min(MAX_WAIT_MS, Math.floor(waitMs) || 0));
      if (bounded === 0) {
        return Promise.resolve();
      }
      return new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          remove();
          resolve();
        }, bounded);
        const done = (): void => {
          clearTimeout(timer);
          remove();
          resolve();
        };
        const remove = (): void => {
          const set = waiters.get(key);
          if (set) {
            set.delete(done);
            if (set.size === 0) {
              waiters.delete(key);
            }
          }
        };
        let set = waiters.get(key);
        if (!set) {
          set = new Set();
          waiters.set(key, set);
        }
        set.add(done);
      });
    },
    dispose(): void {
      sub.dispose();
      waiters.clear();
    },
  };
}
