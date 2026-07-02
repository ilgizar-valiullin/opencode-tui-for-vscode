# Architecture

## Overview

The extension runs in two separate Node.js processes:

1. **Extension Host** (VS Code's Electron Node.js) — manages UI, commands, MCP server, per-view server lifecycle
2. **PTY Helper** (system Node.js) — runs `opencode` with `node-pty` for proper terminal emulation

Each webview (sidebar or tab) gets its own `OpenCodeServerManager` instance with its own PTY helper and opencode process:

```
┌────────────────────────────────────────────────────────┐
│ VS Code Extension Host (Electron Node.js)               │
│                                                         │
│  extension.ts ─── webviewProvider.ts ─── xterm.js       │
│       │                 │├sidebarServer_   (webview)    │
│       │                 │├tabServer_                     │
│       │                 │└activeServer_                  │
│       │                 │                                │
│  commands/attachFile  opencodeServer.ts                  │
│       │                 │  (instantiated per view)       │
│       └─── HTTP ──── OpenCode REST API                   │
│                                                          │
├────────────────────────────────────────────────────────┤
│ Sidebar PTY Helper (system Node.js — sidebarServer_)    │
│                                                         │
│  ptyHelper.js ─── node-pty ─── opencode CLI (port X)    │
│                                                         │
├────────────────────────────────────────────────────────┤
│ Tab PTY Helper (system Node.js — tabServer_)            │
│                                                         │
│  ptyHelper.js ─── node-pty ─── opencode CLI (port Y)    │
│                                                         │
│  stdin:  JSON messages (spawn, stdin, resize, kill)     │
│  stdout: null-delimited frames (data, ready, exit)      │
└────────────────────────────────────────────────────────┘
```

## Data flow

### Startup (sidebar)

```
User opens panel in secondary sidebar
       │
       ▼
webview.ts sends { type: "ready" }
       │
       ▼
webviewProvider.handleMessage() creates sidebarServer_
(new OpenCodeServerManager instance)
       │
       ├─ findNode() → resolves system Node.js path
       ├─ spawn(node, ptyHelper.js)
       ├─ ptyHelper.js spawns opencode CLI via node-pty
       ├─ opencode starts HTTP server on random port
       └─ health poll → OpenCodeClient created
```

### Startup (tab)

```
User runs "OpenCode: Open Terminal" or "OpenCode: Open Tab"
       │
       ▼
webviewProvider.openInTab() creates WebviewPanel
       │
       ▼
webview.ts sends { type: "ready" }
       │
       ▼
webviewProvider.handleMessage() creates tabServer_
(separate OpenCodeServerManager instance)
       │
       └─ Same flow as sidebar, with independent port
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
       ├─ Ctrl+A? → intercept, post { type: "selectAll" }
       └─ Plain text → term.onData → post { type: "textInput" }
              │
              ▼
webviewProvider → server.writeToStdin()
       │
       ▼
ptyHelper: stdin JSON {"type":"stdin","data":"..."}
       │
       ▼
node-pty.write(data) → opencode stdin
```

### Focus tracking

```
User interacts with webview
       │
       ▼
focusin / focusout events
       │
       ▼
webviewProvider sets activeServer_ = focused server
       │
       ▼
attachFile / attachSelection commands use activeServer_
```

## Settings modal

See [Status Bar and Server Architecture](docs/diagrams/statusbar-flow.md) for the full state diagram.

```
User clicks gear (⚙) button in status bar
       │
       ▼
webview.ts posts { type: "openSettings" }
       │
       ▼
webviewProvider reads config, posts { type: "settingsData", ... }
       │
       ▼
Settings overlay shown with fields:
  - OpenCode Path (opencodePath)
  - Server Port (serverPort, 0=auto)
  - Leader Chords (leaderChords, comma-separated)
  - Ctrl+A Select All (ctrlASelectAll, checkbox)
       │
       ├─ Save → cfg.update() with ConfigurationTarget.Global
       └─ Cancel/Escape/backdrop → close overlay
```

## Status bar

The webview has a fixed 22px status bar at the bottom with:

- **Address info**: `Server: localhost:XXXXX` or `Server: Stopped`
- **Restart button**: stops and restarts the current webview's server
- **Shutdown/Start toggle**: stops or starts the current webview's server
- **Settings gear**: opens the settings modal (⚙)

The status bar is part of the webview HTML, not the VS Code status bar API. A separate VS Code status bar item (`$(terminal) OpenCode`) opens a new tab.

## MCP Server (IDE Context Awareness)

An embedded MCP server provides IDE context awareness:

- **Resource**: `editor://context` — current active file path and text selection
- **Auth**: Bearer token stored in a `.lock` file at `$dataDir/opencode/ide/{port}.lock`
- **Transport**: Streamable HTTP on `127.0.0.1:random`
- **Notifications**: Resource updated on editor change (debounced 150ms)
- **Lifecycle**: MCP server is shared; both sidebar and tab PTY helpers receive `mcpPort` in spawn message

## PTY Helper Protocol

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

## Key design decisions

- **`event.code` over `event.key`**: Physical key position is layout-independent
- **HTTP API for hotkeys**: `/tui/execute-command` bypasses the terminal's keyboard handling entirely
- **Separate PTY process**: Node-pty requires matching ABI; system Node.js avoids Electron ABI issues
- **Per-webview server instances**: Each webview (sidebar/tab) gets its own `OpenCodeServerManager`; no global singleton
- **Settings modal in webview HTML**: No VS Code native UI needed; uses overlay div with inline styles
- **`xterm.attachCustomKeyEventHandler`**: Intercepts Ctrl+A at the xterm level to route through our handler
- **Bracketed paste** (`\x1b[200~...\x1b[201~`): All text pastes use bracketed paste mode for proper terminal handling
