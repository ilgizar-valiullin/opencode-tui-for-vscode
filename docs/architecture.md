# Architecture

## Overview

The extension runs in two separate Node.js processes:

1. **Extension Host** (VS Code's Node.js) — manages UI, commands, MCP server
2. **PTY Helper** (system Node.js) — runs `opencode` with `node-pty` for proper terminal emulation

```
┌─────────────────────────────────────────────────────┐
│ VS Code Extension Host (Electron Node.js)            │
│                                                      │
│  extension.ts ─── webviewProvider.ts ─── xterm.js    │
│       │                 │               (webview)    │
│       │                 │                            │
│  commandDispatcher  opencodeServer.ts                │
│       │                 │                            │
│  attachFile.ts    spawn(node, ptyHelper.js)          │
│       │                 │                            │
│       └─── HTTP ──── OpenCode REST API               │
│                                                      │
├─────────────────────────────────────────────────────┤
│ PTY Helper Process (system Node.js)                  │
│                                                      │
│  ptyHelper.js ─── node-pty ─── opencode CLI          │
│                                                      │
│  stdin:  JSON messages (spawn, stdin, resize, kill)  │
│  stdout: null-delimited frames (data, ready, exit)   │
└─────────────────────────────────────────────────────┘
```

## Data flow

### Startup

```
User opens panel
       │
       ▼
webview.ts sends { type: "ready" }
       │
       ▼
webviewProvider.handleMessage() calls serverManager.start()
       │
       ├─ findNode() → resolves system Node.js path
       ├─ spawn(node, ptyHelper.js)
       ├─ ptyHelper.js spawns opencode CLI via node-pty
       ├─ opencode starts HTTP server on random port
       └─ health poll → OpenCodeClient created
```

### Keyboard input

```
User presses keys
       │
       ▼
document.addEventListener("keydown", ...) in webview.ts
       │
       ├─ Leader active? → intercept chord, post { type: "textInput" }
       ├─ Ctrl+X? → activate leader mode (via term.onData("\x18"))
       └─ Plain text → term.onData → post { type: "textInput" }
              │
              ▼
webviewProvider → serverManager.writeToStdin()
       │
       ▼
ptyHelper: stdin JSON {"type":"stdin","data":"..."}
       │
       ▼
node-pty.write(data) → opencode stdin
```

### PTY Helper Protocol

Messages between extension host and PTY helper use newline-delimited JSON over stdin/stdout.

**Input (stdin, JSON per line):**

| Type | Payload | Description |
|------|---------|-------------|
| `spawn` | `{ path, port, cwd?, mcpPort? }` | Start opencode CLI |
| `stdin` | `{ type, data }` | Write to PTY |
| `resize` | `{ type, cols, rows }` | Resize terminal |
| `kill` | `{ type }` | Kill PTY process |

**Output (stdout, null-delimited frames):**

| Prefix | Payload | Description |
|--------|---------|-------------|
| `R` | `{ "pid": 12345 }` | PTY ready with PID |
| `D` | raw string | PTY stdout data |
| `E` | `{ "code": 0 }` | PTY exited |

## MCP Server

An embedded MCP server provides IDE context awareness:

- **Resource**: `editor://context` — current active file path and text selection
- **Auth**: Bearer token stored in a `.lock` file at `$dataDir/opencode/ide/{port}.lock`
- **Transport**: Streamable HTTP on `127.0.0.1:random`
- **Notifications**: Resource updated on editor change (debounced 150ms)

## Key design decisions

- **`event.code` over `event.key`**: Physical key position is layout-independent
- **HTTP API for hotkeys**: `/tui/execute-command` bypasses the terminal's keyboard handling entirely
- **Separate PTY process**: Node-pty requires matching ABI; system Node.js avoids Electron ABI issues
- **Singleton server**: One opencode process per VS Code window, shared between sidebar and tab views
