# Architecture Decision Records

## ADR-001: Use `event.code` over `event.key` for keyboard handling

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

**Date**: 2025-03 (project inception)

**Context**: xterm.js can handle both rendering and input. However, its input processing uses the deprecated `keypress` event and has inconsistent behavior across platforms, especially with non-ASCII input.

**Decision**: Use xterm.js strictly for rendering ANSI output. All input (plain text and leader chords) goes through a custom keyboard interceptor that bypasses xterm.js's input handling.

**Consequences**:
- xterm.js is purely a visual terminal emulator
- Plain text input still flows through `term.onData` (which captures raw terminal input), but hotkeys are intercepted at the `document` level
- No dependency on xterm.js addon for input handling
- Clean separation: xterm.js renders what the extension tells it to render

---

## ADR-006: Singleton server manager per VS Code window

**Date**: 2025-03 (project inception)

**Context**: Users can open OpenCode in both the sidebar view and as a tab. Each instance could theoretically start its own opencode process, wasting resources.

**Decision**: Use a singleton `serverManager` (module-level export) shared across all view instances. The sidebar and tab use the same opencode process.

**Consequences**:
- One opencode process per VS Code window
- Both views show exactly the same terminal output
- Stopping the server stops it for all views
- `isRunning()` check prevents double-start

---

## ADR-007: Embed MCP server for IDE context awareness

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

**Date**: 2026-07 (v1.1.1)

**Context**: The extension is used by non-English speakers. Command titles, config descriptions, and error messages need translation.

**Decision**: Use VS Code's built-in localization pipeline:
- `package.nls.json` + locale variants for `package.json` strings
- `l10n/bundle.l10n.json` + locale variants for code strings via `vscode.l10n.t()`

**Consequences**:
- No third-party i18n library needed
- VS Code handles locale detection and file resolution automatically
- 10 languages shipped initially
- Missing translations fall back to English silently

---

## ADR-010: [`useConptyDll: true`](https://github.com/microsoft/node-pty) on Windows

**Date**: 2025-03 (project inception)

**Context**: On Windows, `node-pty` can use either the legacy Win32 PTY API or the modern ConPTY API (Windows 10 1809+). The legacy API has issues with modern terminal applications (rendering, resize behavior, unicode).

**Decision**: Enable `useConptyDll: true` and `conptyInheritCursor: false` in `node-pty` spawn options on all platforms (non-Windows ignores these flags).

**Consequences**:
- Modern terminal behavior on Windows 10/11
- Proper resize handling with ConPTY
- No cursor inheritance (prevents cursor position issues)
- No platform detection needed — flags are no-ops on Linux/macOS
