# Changelog

## 1.0.0 — Initial Release

### Features
- OpenCode TUI embedded in VS Code webview panel via xterm.js 5.5.0
- PTY-based terminal emulation through node-pty for proper I/O
- Binary null-delimited stdout protocol for efficient data transfer
- Server lifecycle tied to webview panel visibility
- Working directory set to VS Code workspace folder
- Resize forwarding from webview to PTY

### Ghosting Fix
- Cleaned terminal environment variables (WT_SESSION, TERM_PROGRAM, etc.) passed to PTY to prevent opencode from using synchronized output markers (\x1b[?2026h/l) incompatible with node-pty/ConPTY
- Added PTY options: `useConptyDll: true`, `conptyInheritCursor: false`, `handleFlowControl: false`

### Testing
- `test/liveview.mjs` — standalone PTY bridge for testing opencode output in native PowerShell without VS Code

### Known Limitations
- Emacs-style leader key sequences (Ctrl+X + follow-up) pending
- Non-Latin keyboard layout input pending
