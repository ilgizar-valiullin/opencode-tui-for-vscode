# Architecture Decision Records

## ADR-001: Use `event.code` over `event.key` for keyboard handling

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: VS Code's built-in terminal uses `event.key` to detect keyboard input. On Cyrillic, Korean, Japanese, and other non-Latin layouts, `event.key` returns localized characters (e.g., `ч` instead of `x`, `ь` instead of `m`), making every keyboard shortcut layout-dependent and broken for non-Latin users.

**Decision**: Intercept keyboard at the `document` level using `event.code` (physical USB HID position), which is identical across all keyboard layouts.

**Consequences**:
- All hotkeys work on any keyboard layout without configuration
- Need to manually translate `event.code` → ASCII (`codeToAscii()`)
- Shift handling for symbol keys must be done manually (e.g., `Digit2` + Shift → `@`)
- Leader chord key names are always physical (lowercase ASCII letters based on US layout position)

**Alternatives considered**:
- `event.key` with layout detection — impossible to detect all layouts reliably
- Raw xterm.js keypress event — deprecated, behaves differently across browsers

---

## ADR-002: Two-process architecture (extension host + PTY helper)

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: VS Code extensions run in Electron's Node.js runtime. `node-pty` is a native C++ module compiled against a specific Node.js ABI. Electron uses a custom Node.js ABI that differs from system Node.js. Loading `node-pty` compiled for system Node.js into Electron's runtime causes `ERR_DLOPEN_FAILED`.

**Decision**: Run `node-pty` in a **separate process** using system Node.js (`node ptyHelper.js`), communicating via JSON messages over stdin/stdout.

**Consequences**:
- Two processes to manage, monitor, and clean up
- IPC protocol needed (newline-delimited JSON input, null-delimited frames output)
- Startup orchestration: spawn helper → helper spawns opencode → health poll → ready
- `findNode()` needs to locate system Node.js on all platforms
- More complex error handling (helper crash, PTY exit, timeout)

**Why not alternatives**:
- `electron-rebuild` — unreliable, VS Code uses custom Electron builds not aligned with public releases
- Direct `child_process.spawn` (no PTY) — loses terminal capabilities (resize, proper TTY signals, Ctrl+C handling)
- VS Code's `createTerminal` API — `event.key` bug is unfixable upstream
- Embedding Node.js runtime in the extension — violates VS Code extension guidelines

---

## ADR-003: Use system Node.js, not Electron's `process.execPath`, for PTY helper

**Status**: Active
**Date**: 2026-07 (v1.1.1)

**Context**: Originally, `findNode()` checked only Windows `Program Files` paths, then fell back to `process.execPath` (Electron's Node.js). On Linux/macOS, it always used Electron. This meant `node-pty` loaded under Electron ABI, which often failed or produced undefined behavior.

**Decision**: Search for system Node.js in `PATH` on all platforms. If not found, **throw a clear error** rather than silently falling back to Electron ABI.

**Consequences**:
- System Node.js is a hard requirement for the extension to function
- Users without Node.js get a VS Code error notification with installation link
- Linux/macOS users get the same robust behavior as Windows
- Electron fallback is eliminated entirely

---

## ADR-004: HTTP API for hotkey commands, bypassing terminal input

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: OpenCode processes keyboard input through its TUI. Leader chord commands could be sent as keystrokes through the PTY, but this is fragile: timing issues, race conditions with terminal state, and the terminal might be in insert mode or processing a different command.

**Decision**: Send leader chord commands via `HTTP POST /tui/execute-command` directly to OpenCode's REST API, bypassing the terminal input entirely.

**Consequences**:
- Leader commands are reliable regardless of terminal state
- Can trigger any TUI command programmatically (session list, model switch, etc.)
- The webview's `textInput` messages for leader chords are actually ASCII characters, but the extension host translates them via `executeTuiCommand()`
- Adds HTTP client dependency

---

## ADR-005: xterm.js for rendering only, not input processing

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: xterm.js can handle both rendering and input. However, its input processing uses the deprecated `keypress` event and has inconsistent behavior across platforms, especially with non-ASCII input.

**Decision**: Use xterm.js strictly for rendering ANSI output. All input (plain text and leader chords) goes through a custom keyboard interceptor that bypasses xterm.js's input handling.

**Consequences**:
- xterm.js is purely a visual terminal emulator
- Plain text input still flows through `term.onData` (which captures raw terminal input), but hotkeys are intercepted at the `document` level
- No dependency on xterm.js addon for input handling
- Clean separation: xterm.js renders what the extension tells it to render

---

## ADR-006: Per-webview server instances (replaces singleton)

**Status**: Active (supersedes original singleton approach as of v1.5.0)
**Date**: 2026-07-02 (v1.5.0)

**Context**: Users can open OpenCode in both the sidebar view and as a tab. Initially, a singleton `serverManager` was shared across all views. This meant both views showed identical terminal output and stopping the server affected both. The singleton was exported as a module-level variable, creating tight coupling.

**Decision**: Each webview (sidebar or tab) gets its own `OpenCodeServerManager` instance, stored in `webviewProvider` as `sidebarServer_` and `tabServer_`. The `activeServer_` pointer tracks which view most recently had focus. Commands use `provider!.getActiveServer()` to target the correct instance.

**Consequences**:
- Each view has its own opencode process and port
- Restarting one view doesn't affect the other
- Commands (attach file, paste) target the focused view
- Slightly more resource usage (two opencode processes)
- Cleaner lifecycle: commands reference the provider, not a module-level singleton

**Migration from singleton**:
- Previously: `serverManager` was a module-level export in `opencodeServer.ts`
- Now: `webviewProvider` creates `new OpenCodeServerManager()` per view
- Commands check `provider!.getActiveServer()` before operating

---

## ADR-007: Embed MCP server for IDE context awareness

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: OpenCode needs to know about the current editor state (active file, selection) to provide context-aware code assistance. Polling the editor state from OpenCode would be inefficient and fragile.

**Decision**: Run a lightweight MCP server inside the extension host on a random port. Expose the editor state as an MCP resource (`editor://context`). Secure with a random Bearer token shared via a lock file.

**Consequences**:
- OpenCode can subscribe to editor context changes
- Editor state is pushed on change (debounced 150ms) rather than polled
- Additional HTTP server to manage
- Auth token in lock file prevents unauthorized access from other processes
- `@modelcontextprotocol/sdk` dependency added

---

## ADR-008: Leader key via raw byte detection in PTY output

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: When the user presses `Ctrl+X` in the terminal, opencode sends this through the PTY output as the raw byte `\x18`. The extension needs to detect this to activate leader mode.

**Decision**: The webview's `term.onData` callback inspects incoming data for the `\x18` byte and activates leader mode locally. Leader chord presses are then intercepted by the keyboard handler and prevented from reaching the terminal.

**Consequences**:
- Leader activation is purely client-side (no round-trip)
- 2000ms timeout auto-clears leader mode if no chord is pressed
- `Escape` key also clears leader mode (handled in keyboard handler)
- Leader chords do not appear in the terminal output

---

## ADR-009: Localization via `package.nls` + `vscode.l10n`

**Status**: Active
**Date**: 2026-07 (v1.1.1)

**Context**: The extension is used by non-English speakers. Command titles, config descriptions, and error messages need translation.

**Decision**: Use VS Code's built-in localization pipeline:
- `package.nls.json` + locale variants for `package.json` strings
- `l10n/bundle.l10n.json` + locale variants for code strings via `vscode.l10n.t()`

**Consequences**:
- No third-party i18n library needed
- VS Code handles locale detection and file resolution automatically
- 10 languages shipped initially; settings modal strings also localized
- Missing translations fall back to English silently

---

## ADR-010: [`useConptyDll: true`](https://github.com/microsoft/node-pty) on Windows

**Status**: Active
**Date**: 2025-03 (project inception)

**Context**: On Windows, `node-pty` can use either the legacy Win32 PTY API or the modern ConPTY API (Windows 10 1809+). The legacy API has issues with modern terminal applications (rendering, resize behavior, unicode).

**Decision**: Enable `useConptyDll: true` and `conptyInheritCursor: false` in `node-pty` spawn options on all platforms (non-Windows ignores these flags).

**Consequences**:
- Modern terminal behavior on Windows 10/11
- Proper resize handling with ConPTY
- No cursor inheritance (prevents cursor position issues)
- No platform detection needed — flags are no-ops on Linux/macOS

---

## ADR-011: Settings modal as webview overlay

**Status**: Active
**Date**: 2026-07-02 (v1.4.0)

**Context**: Users need to configure the opencode path, server port, leader chords, and Ctrl+A behavior without editing VS Code settings JSON directly or using a separate settings page. VS Code's native settings UI is adequate but hard to discover.

**Decision**: Implement a settings modal as an HTML overlay inside the webview itself, styled to match GitHub Dark theme (#0d1117 background, #58a6ff accents). Settings are persisted via `vscode.workspace.getConfiguration().update()` with `ConfigurationTarget.Global`.

**Consequences**:
- Settings are accessible via a gear button in the status bar
- No native VS Code UI overhead; all styling is inline CSS in the webview HTML
- Settings persist across VS Code restarts
- Modal can be closed via Cancel, Escape key, or backdrop click
- All setting labels are localized via `vscode.l10n.t()`

**Fields in settings modal**:
- **OpenCode Path** — path to opencode binary (string)
- **Server Port** — port for REST API (0 = auto) (integer)
- **Leader Chords** — leader mode chord keys, comma-separated (string[])
- **Ctrl+A Select All (fix)** — checkbox to enable/disable Ctrl+A interception for select-all behavior

---

## ADR-012: Ctrl+A select all interception

**Status**: Active
**Date**: 2026-07-02 (v1.4.0)

**Context**: In a terminal emulator, Ctrl+A normally sends `\x01` (SOH) to the PTY. In many terminal applications, this is mapped to "beginning of line" or "select all" depending on context. Users expected Ctrl+A in the OpenCode terminal to function as a TUI command (select all input text) rather than sending raw `\x01`. Additionally, VS Code's webview intercepts Ctrl+A natively for select-all, creating a conflict.

**Decision**: Intercept Ctrl+A at three levels:
1. `xterm.attachCustomKeyEventHandler` — prevents xterm from processing Ctrl+A
2. `document keydown` capture phase — prevents the browser's default select-all
3. `term.onData` — intercepts `\x01` byte and sends `{ type: "selectAll" }` instead

The `selectAll` message triggers `OpenCodeClient.executeTuiCommand("input_select_all")` via HTTP, with a fallback to sending `\x1b[97;9u` (CSI u sequence) via stdin if HTTP fails.

**Consequences**:
- Ctrl+A triggers "select all" in the TUI input, not raw byte
- Configurable via `opencode-tui-unofficial.ctrlASelectAll` setting (default: true)
- When disabled, Ctrl+A sends `\x01` through the PTY as normal
- The `__CTRL_A_SELECT_ALL__` JS variable is injected into the webview HTML at construction time

---

## ADR-013: Paste via bracketed paste mode

**Status**: Active
**Date**: 2026-07-02 (v1.3.0)

**Context**: Pasting text into a terminal sends each character as if typed, which can trigger unintended behavior (e.g., pasting multi-line text into a shell executes commands immediately). Proper terminal applications use bracketed paste mode (`\x1b[200~...\x1b[201~`) to indicate paste boundaries.

**Decision**: All pastes are wrapped in bracketed paste sequences:
- Native paste events (`Ctrl+V` or right-click paste): intercept via `document paste` event, read clipboard data, wrap in `\x1b[200~...\x1b[201~`
- Term.onData `\x16` (Ctrl+V raw byte): send `{ type: "clipboardPaste" }` to extension host, which reads clipboard via `vscode.env.clipboard.readText()` and writes bracketed paste to PTY

**Consequences**:
- Applications that support bracketed paste display pasted text differently (e.g., no auto-indent)
- Multi-line pastes don't execute immediately in bash/zsh
- `handlePaste` command registered as `opencode-tui-unofficial.handlePaste` for programmatic use
- Clipboard read permission may trigger a VS Code permission prompt on first use

---

## ADR-014: Separate sidebar and tab server instances

**Status**: Active
**Date**: 2026-07-02 (v1.5.0)

**Context**: The sidebar and tab views share the same icon and serve the same purpose. Users who open both expect independent terminals (different working directories, different sessions). The original singleton design forced both views into the same terminal.

**Decision**: The `webviewProvider` tracks two `OpenCodeServerManager` instances: `sidebarServer_` and `tabServer_`. A `sidebarServerStarted_` / `tabServerStarted_` flag prevents double-start per view. `activeServer_` is set on focus and used by attach/command operations.

**Consequences**:
- Each view type gets its own opencode process
- Commands that need a server context check `getActiveServer()`
- `stopAllServers()` iterates both instances
- MCP `mcpPort` is shared between instances (both connect to the same MCP server)
- Focus tracking determines which server receives attach/paste commands
