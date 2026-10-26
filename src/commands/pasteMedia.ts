import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const MAX_BYTES = 20 * 1024 * 1024;

const MIME_EXTS: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
};

export interface PastedBitmap {
  /** Suggested file name (no path), e.g. "image.png" from the clipboard */
  name: string;
  mime: string;
  /** Raw bytes as base64 */
  base64: string;
}

export type SaveBitmapResult =
  | { ok: true; path: string }
  | { ok: false; error: string };

function safeBase(name: string, ext: string): string {
  const cleaned = name
    .toLowerCase()
    .replace(/[^a-z0-9-_]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "clipboard-image";
  return `${cleaned}-${Date.now()}.${ext}`;
}

/**
 * Materialize a clipboard bitmap (e.g. a screenshot, which has no filesystem
 * identity) into a temp file so it can be passed to the TUI by path — the
 * same thing native terminals do. OS file copies already carry their real
 * path and never reach this function.
 */
export async function savePastedBitmap(
  img: PastedBitmap
): Promise<SaveBitmapResult> {
  const ext = MIME_EXTS[img.mime] ?? null;
  if (!ext) {
    return { ok: false, error: `Unsupported pasted image type: ${img.mime || "unknown"}` };
  }
  let buf: Buffer;
  try {
    buf = Buffer.from(img.base64, "base64");
  } catch {
    return { ok: false, error: "Could not decode pasted image" };
  }
  if (buf.length === 0) {
    return { ok: false, error: "Pasted image is empty" };
  }
  if (buf.length > MAX_BYTES) {
    return { ok: false, error: "Pasted image is too large (max 20 MB)" };
  }
  try {
    const dir = path.join(os.tmpdir(), "opencode-tui-media");
    fs.mkdirSync(dir, { recursive: true });
    const abs = path.join(dir, safeBase(path.parse(img.name).name, ext));
    fs.writeFileSync(abs, buf, { mode: 0o600 });
    return { ok: true, path: abs };
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return { ok: false, error: `Could not save pasted image: ${msg}` };
  }
}
