# Keyboard Handling

This is the core innovation of the extension. VS Code's built-in terminal uses `event.key` to detect keyboard input, which is **layout-dependent**. On Cyrillic, Korean, or other non-Latin layouts, `event.key` returns localized characters instead of the expected ASCII values, breaking keyboard shortcuts.

## Approach

The extension intercepts keyboard events **before** xterm.js processes them, using `event.code` — the physical key position on the keyboard, which never changes regardless of the active language layout.

## Key interception flow

```
User presses Ctrl+X (Cyrillic layout: Ctrl+ч)
       │
       │ event.code = "KeyX" (same on all layouts)
       │ event.key  = "ч"  (Cyrillic on RU layout)
       │
       ▼
document.addEventListener("keydown", capture phase)
       │
       │ leaderActive = false (default)
       │ Is this Ctrl+X? → No (handled by term.onData)
       │
       ▼
term.onData receives "\x18" (Ctrl+X raw byte)
       │
       │ leaderActive = true
       │ Start 2000ms timeout
       │
       ▼
User presses M (Cyrillic layout: ь)
       │
       │ event.code = "KeyM"
       │ event.key  = "ь"
       │
       ▼
document.addEventListener("keydown", capture phase)
       │
       │ leaderActive = true
       │ codeToAscii("KeyM") → "m"
       │ leaderChords.has("m") → true
       │
       │ e.preventDefault()
       │ e.stopPropagation()
       │ Post { type: "textInput", data: "m" }
       │
       ▼
HTTP POST /tui/execute-command → session_list
```

## Leader key implementation

The leader key is `Ctrl+X` (physical Ctrl+X position). This is sent from `opencode` as the raw byte `\x18` through the PTY data stream. The webview's `term.onData` callback detects this byte and sets `leaderActive = true`.

```typescript
term.onData((data: string) => {
  if (data === "\x18") {
    leaderActive = true;
    clearTimeout(leaderTimer);
    leaderTimer = setTimeout(clearLeader, LEADER_TIMEOUT); // 2000ms
  }
  vscode.postMessage({ type: "textInput", data });
});
```

When leader mode is active, subsequent key presses are intercepted by the `keydown` handler, translated from `event.code` to ASCII, and sent as leader chord commands. Leader mode auto-clears after 2000ms of inactivity or on `Escape`.

## Code to ASCII mapping

The `codeToAscii()` function translates physical key codes to ASCII characters:

- **Letter keys** (`KeyA`-`KeyZ`): Extracts the letter, lowercased
- **Digit keys** (`Digit0`-`Digit9`): Returns the digit, or shifted symbol with Shift
- **Symbol keys**: Maps `event.code` values like `Minus`, `BracketLeft`, `Semicolon`, etc. to their unshifted ASCII equivalents
- **Shift handling**: Applied only for digit keys (e.g., `Shift+Digit2` → `@`)

```typescript
function codeToAscii(code: string, shift: boolean): string | null {
  if (code.startsWith("Key")) {
    return code.slice(3).toLowerCase();
  }
  if (code.startsWith("Digit")) {
    if (shift) return shiftedMap[digit]; // "0" → ")", "2" → "@", etc.
    return digit;
  }
  // Symbol keys...
}
```

## Customizing leader chords

Leader chord characters can be configured via the `opencode-tui-unofficial.leaderChords` setting in VS Code settings. If empty, the extension reads from `tui.json` in OpenCode's config directory, falling back to the full default set:

```
n, l, c, x, g, m, a, e, t, s, b, h, y, u, r, q
```

## Why this works

| Approach | Mechanism | Cyrillic | Korean | Japanese |
|----------|-----------|----------|-------|----------|
| VS Code terminal | `event.key` | ❌ Broken | ❌ Broken | ❌ Broken |
| This extension | `event.code` | ✅ Works | ✅ Works | ✅ Works |
| Raw xterm.js | keypress event | ⚠️ Partial | ⚠️ Partial | ❌ Broken |
