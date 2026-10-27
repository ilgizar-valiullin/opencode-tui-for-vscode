import { Plugin } from "@opencode/plugin";

interface DiagnosticsArgs {
  /** Absolute path or file:// URI. Relative paths resolve against the workspace. */
  file: string;
  /** Wait up to this many ms for fresh diagnostics after an edit (0-10000). */
  waitMs?: number;
  /** Epoch ms of the last edit; when set with waitMs, the bridge waits for a newer push. */
  freshAfter?: number;
  /** Also return the open (possibly dirty) buffer text, capped at 50k chars. */
  includeContent?: boolean;
}

interface ToolContext {
  signal?: AbortSignal;
}

interface BridgeDiagnostic {
  severity: string;
  range: {
    start: { line: number; column: number };
    end: { line: number; column: number };
  };
  message: string;
  source?: string;
  code?: string;
}

interface BridgeSnapshot {
  file: string;
  diagnostics: BridgeDiagnostic[];
  stale?: boolean;
  count: number;
}

interface AfterEvent {
  tool: string;
  input: unknown;
  status: "completed" | "error";
  result?: {
    output?: unknown;
    content?: unknown;
    metadata?: Record<string, unknown>;
  };
}

const OWN_TOOL = "vscode_diagnostics";
const MUTATION_TOOLS = new Set(["write", "edit", "multiedit", "patch", "apply_patch"]);
const HOOK_WAIT_MS = 2000;
const HOOK_TIMEOUT_MS = 8000;
const MAX_APPEND_DIAGNOSTICS = 20;

/** Identities of diagnostics already shown, per file — avoids repeating persistent warnings. */
const seenByFile = new Map<string, Set<string>>();

function bridgeBase(): string {
  return process.env.OPENCODE_VSCODE_BRIDGE_URL ?? "";
}

function bridgeToken(): string {
  return process.env.OPENCODE_VSCODE_BRIDGE_TOKEN ?? "";
}

function fileFromInput(input: unknown): string | undefined {
  if (!input || typeof input !== "object") {
    return undefined;
  }
  const rec = input as Record<string, unknown>;
  for (const key of ["filePath", "file_path", "path", "file"]) {
    const v = rec[key];
    if (typeof v === "string" && v.length > 0) {
      return v;
    }
  }
  return undefined;
}

function diagId(d: BridgeDiagnostic): string {
  return `${d.severity}:${d.range.start.line}:${d.range.start.column}:${d.message}`;
}

function shortFile(file: string): string {
  return file.split(/[/\\]/).slice(-2).join("/");
}

async function fetchSnapshot(
  file: string,
  freshAfter: number,
  waitMs: number,
  timeoutMs: number,
): Promise<BridgeSnapshot | undefined> {
  const base = bridgeBase();
  if (!base) {
    return undefined;
  }
  const params = new URLSearchParams({
    file,
    freshAfter: String(freshAfter),
    waitMs: String(waitMs),
  });
  try {
    const res = await fetch(`${base}/diagnostics?${params.toString()}`, {
      headers: bridgeToken() ? { Authorization: `Bearer ${bridgeToken()}` } : {},
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      return undefined;
    }
    return (await res.json()) as BridgeSnapshot;
  } catch {
    return undefined;
  }
}

function appendText(
  result: NonNullable<AfterEvent["result"]>,
  text: string,
): void {
  if (typeof result.output === "string") {
    result.output += text;
    return;
  }
  if (typeof result.content === "string" || result.content === undefined) {
    result.content = (result.content ?? "") + text;
    return;
  }
  if (Array.isArray(result.content)) {
    (result.content as Array<{ type: string; text: string }>).push({ type: "text", text });
    return;
  }
  result.metadata = { ...(result.metadata ?? {}), vscodeDiagnostics: text.trim() };
}

function formatBlock(file: string, snap: BridgeSnapshot, fresh: BridgeDiagnostic[]): string {
  const shown = fresh.slice(0, MAX_APPEND_DIAGNOSTICS);
  const lines = shown.map(
    (d) =>
      `- [${d.severity}] ${d.range.start.line + 1}:${d.range.start.column + 1}` +
      ` ${d.message}${d.code ? ` (${d.code})` : ""}${d.source ? ` [${d.source}]` : ""}`,
  );
  const more = fresh.length > shown.length ? `\n… +${fresh.length - shown.length} more` : "";
  const staleNote = snap.stale ? " (stale — analyzer still running)" : "";
  return `\n\nVS Code diagnostics (${shortFile(file)})${staleNote}:\n${lines.join("\n")}${more}`;
}

/**
 * vscode-bridge: live VS Code Problems as an opencode tool + automatic
 * post-edit check.
 *
 * The extension host (same process as all warm language servers) serves
 * GET /diagnostics on 127.0.0.1; this plugin is only a thin fetch wrapper.
 * Prefer this over running linters via shell: zero extra LS processes and
 * dirty-buffer aware (see isDirty/version/stale in the response).
 *
 * Diagnostics are also auto-attached to write/edit results via the
 * execute.after hook below, so the agent sees new problems without asking.
 */
export default Plugin.define({
  id: "vscode-bridge",
  async setup(ctx) {
    await ctx.tool.transform((editor) => {
      editor.add({
        name: OWN_TOOL,
        description:
          "Read live VS Code Problems for ONE file (all providers: tsc, ESLint, Dart-Code, built-ins), including unsaved buffer state. Ranges are 0-based. Prefer this over shell linters. Note: diagnostics are also auto-attached after write/edit tool calls, so manual checks are only needed for files you did not just edit.",
        input: {
          type: "object",
          properties: {
            file: {
              type: "string",
              description: "Absolute file path or file:// URI",
            },
            waitMs: {
              type: "number",
              description: "Long-poll up to N ms for fresh diagnostics (0-10000, default 0)",
            },
            freshAfter: {
              type: "number",
              description: "Epoch ms of the last edit; bridge waits for diagnostics newer than this",
            },
            includeContent: {
              type: "boolean",
              description: "Include the open dirty buffer text (capped), default false",
            },
          },
          required: ["file"],
          additionalProperties: false,
        },
        execute: async (input, context) => {
          const args = input as DiagnosticsArgs;
          const ctxSignal = (context as ToolContext | undefined)?.signal;
          const base = bridgeBase();
          if (!base) {
            return {
              content: JSON.stringify({
                error: "VS Code bridge not configured (OPENCODE_VSCODE_BRIDGE_URL missing)",
              }),
            };
          }
          const params = new URLSearchParams({ file: args.file });
          if (args.waitMs !== undefined) {
            params.set("waitMs", String(args.waitMs));
          }
          if (args.freshAfter !== undefined) {
            params.set("freshAfter", String(args.freshAfter));
          }
          if (args.includeContent !== undefined) {
            params.set("includeContent", String(args.includeContent));
          }
          let res: Response;
          try {
            res = await fetch(`${base}/diagnostics?${params.toString()}`, {
              headers: bridgeToken() ? { Authorization: `Bearer ${bridgeToken()}` } : {},
              signal: ctxSignal,
            });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            return { content: JSON.stringify({ error: `Bridge unreachable: ${msg}` }) };
          }
          const text = await res.text();
          if (!res.ok) {
            return { content: JSON.stringify({ error: `Bridge HTTP ${res.status}: ${text.slice(0, 500)}` }) };
          }
          return { content: text };
        },
      });
    });

    await ctx.tool.hook("execute.after", async (event) => {
      const e = event as unknown as AfterEvent;
      if (e.status !== "completed" || !e.result) {
        return;
      }
      if (e.tool === OWN_TOOL || !MUTATION_TOOLS.has(e.tool)) {
        return;
      }
      const file = fileFromInput(e.input);
      if (!file) {
        return;
      }
      const startedAt = Date.now();
      const snap = await fetchSnapshot(file, startedAt, HOOK_WAIT_MS, HOOK_TIMEOUT_MS);
      if (!snap) {
        return;
      }
      const problems = snap.diagnostics.filter((d) => d.severity === "error" || d.severity === "warning");
      const key = snap.file || file;
      const seen = seenByFile.get(key) ?? new Set<string>();
      const fresh = problems.filter((d) => !seen.has(diagId(d)));
      seenByFile.set(key, new Set(problems.map(diagId)));
      if (fresh.length === 0) {
        if (problems.length === 0) {
          appendText(e.result, `\n\nVS Code diagnostics (${shortFile(key)}): clean.`);
        }
        return;
      }
      appendText(e.result, formatBlock(key, snap, fresh));
    });
  },
});
