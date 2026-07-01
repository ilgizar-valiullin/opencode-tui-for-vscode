# OpenCode TUI — Unofficial VS Code Integration

VS Code extension that embeds OpenCode TUI in a webview panel with proper keyboard handling for all layouts (Cyrillic, Korean, etc.).

## Architecture

```
VS Code Webview Panel
├── xterm.js (ANSI renderer — output only)
├── Keyboard Interceptor (event.code — works on any layout)
│   ├── Ctrl+key → HTTP /tui/execute-command  (bypasses terminal bug)
│   ├── Leader (Ctrl+X) → key sequence → HTTP
│   └── Plain text → xterm.js → opencode stdin
│
Extension Host (Node.js)
├── OpenCodeServerManager — spawns opencode, captures stdout
├── OpenCodeClient — typed HTTP client for opencode REST API
├── CommandDispatcher — routes DispatchedCommand → TUI or custom actions
└── KeyboardHandler — matches event.code → TuiCommandId
```

### Why this works

- `event.code` is the physical key position — never changes with layout
- VS Code's built-in terminal uses `event.key` (layout-dependent) → broken for non-Latin
- We intercept keyboard BEFORE xterm.js processes it, bypass the bug entirely
- Commands sent via HTTP `/tui/execute-command` — no terminal keyboard issues

## Build

```bash
npm install
npm run build
```

Output:
- `dist/extension.js` — extension host bundle (~17KB)
- `dist/webview.js` — webview bundle with xterm.js (~424KB)
- `dist/webview.css` — xterm CSS (~5KB)

## Watch mode

```bash
npm run watch
```

## Type check

```bash
npx tsc --noEmit
```

## Test locally

1. Press F5 in VS Code (or run "Extension Development Host" launch config)
2. Open the OpenCode panel from the activity bar
3. Or: Ctrl+Shift+P → "OpenCode: Open Terminal"

The extension starts `opencode` server on a random port. The TUI output appears in the webview panel.

### Manual keyboard tests

| Action | Expected |
|--------|----------|
| Switch to RU layout, press Ctrl+ч (physical Ctrl+X) | Leader activates |
| Leader active, press ь (physical M) | Session list opens (leader+m) |
| Type Russian text `привет` | Text appears as-is in input |
| Ctrl+й (physical Ctrl+Q) | Should NOT trigger — no mapping for Ctrl+Q in default keybinds |
| Switch layout mid-session | Keyboard interceptor continues working (event.code is stable) |

## Package for distribution

```bash
npx vsce package
```

Produces `opencode-tui-unofficial-<version>.vsix`.

## Project structure

```
├── src/
│   ├── extension.ts              # Entry point
│   ├── types.ts                  # All types and interfaces
│   ├── opencodeServer.ts         # opencode lifecycle manager
│   ├── httpClient.ts             # Typed REST API client
│   ├── keyboardHandler.ts        # event.code → TUI command matching
│   ├── commandDispatcher.ts      # Extensible command dispatch
│   ├── webviewProvider.ts        # Webview panel with xterm.js
│   ├── ui/
│   │   └── webview.ts            # Frontend: terminal + keyboard interceptor
│   └── commands/
│       └── attachFile.ts         # Example custom action: attach file to prompt
├── esbuild.mjs                   # Build script (extension + webview)
├── package.json
├── tsconfig.json
└── AGENTS.md
```

## Extending with custom actions

1. Create handler in `src/commands/yourAction.ts`
2. Register in `extension.ts`: `dispatcher.registerCustomAction("yourAction", handler)`
3. Trigger via:
   - Keyboard: add entry to `DEFAULT_KEYBINDINGS` with `command: { customAction: "yourAction" }`
   - Context menu: add `contributes.menus` entry in `package.json`
   - VS Code command: register new command in `contributes.commands`

## Key design decisions

- **event.code over event.key**: Physical position, layout-agnostic
- **HTTP API for hotkeys**: `/tui/execute-command` bypasses terminal completely
- **xterm.js for rendering only**: Text input passes through normally (Cyrillic works)
- **Singleton server manager**: One opencode process per VS Code window
- **Extensible dispatcher**: Custom actions can be added without touching core code
