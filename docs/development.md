# Development Guide

## Build commands

```bash
npm install          # Install dependencies
npm run build        # Build extension + webview bundles
npm run watch        # Watch mode (re-build on changes)
npm run lint         # ESLint check
npx tsc --noEmit     # TypeScript type checking
npm test             # Smoke tests (test/smoke.mjs)
npx vsce package     # Build + package VSIX
```

## Project structure

```
├── src/
│   ├── extension.ts              # Entry point, activation, MCP lifecycle
│   ├── types.ts                  # TUI command IDs and shared types
│   ├── opencodeServer.ts         # OpenCode process lifecycle + PTY helper
│   ├── ptyHelper.js              # node-pty process for terminal emulation
│   ├── httpClient.ts             # Typed REST client for OpenCode API
│   ├── webviewProvider.ts        # Webview panel with xterm.js + settings modal
│   ├── mcp-server.ts             # MCP server for IDE context
│   ├── vscode-editor-state.ts    # Current editor state provider
│   ├── commands/
│   │   └── attachFile.ts         # Attach file/selection commands
│   └── ui/
│       └── webview.ts            # Frontend: terminal + keyboard interceptor
├── l10n/                         # Localization bundles (11 locales)
├── esbuild.mjs                   # Build script (extension + webview + helper)
├── tsconfig.json
└── eslint.config.mjs             # ESLint flat config
```

## Build system

The project uses a single `esbuild.mjs` script that builds three outputs:

- **`dist/extension.js`** — Extension host bundle (~17KB, bundled + minified)
- **`dist/webview.js`** — Webview bundle with xterm.js (~424KB, bundled + minified)
- **`dist/webview.css`** — xterm CSS (~5KB, copied from @xterm/xterm)

The build script:
1. Bundles the extension host with all dependencies
2. Bundles the webview frontend with xterm.js + fit addon
3. Copies xterm CSS
4. Copies `ptyHelper.js` to `dist/` (no bundling needed)

## TypeScript configuration

- Target: `ES2022`
- Module: `commonjs` (for extension host), bundled separately via esbuild
- Strict mode enabled
- `@types/vscode` for VS Code API types

## Adding a new feature

1. **Create the handler** in `src/commands/` or modify existing files
2. **Register commands** in `src/extension.ts` via `context.subscriptions.push()`
3. **Add keyboard bindings** in `package.json` under `contributes.keybindings`
4. **Add menu items** in `package.json` under `contributes.menus`
5. **Localize strings** in `l10n/bundle.l10n.json` and `package.nls.json`
6. **Build and test**: `npm run build && npm test`

## Adding a setting

1. Add the setting in `package.json` under `contributes.configuration.properties`
2. Add the description in `package.nls.json` (`%cfg.yourSetting.desc%`)
3. Read the setting via `vscode.workspace.getConfiguration("opencode-tui-unofficial")`
4. If it needs UI in the settings modal, add a field in `webviewProvider.ts` `html()` method and handle `openSettings`/`saveSettings` messages

## Testing

Smoke tests are in `test/smoke.mjs`. They verify:
- Build output files exist
- package.json structure
- Icons exist
- Locale files are valid
- TypeScript compiles without errors

Run with:

```bash
npm test
```

## Local development workflow

1. Open the project in VS Code
2. Press `F5` to launch Extension Development Host
3. Make changes to source files
4. Run `npm run build` to rebuild
5. Reload the extension development window (`Ctrl+Shift+P` → "Developer: Reload Window")
6. For watch mode: `npm run watch` in a terminal, then reload

## Architecture overview

See [Architecture](docs/architecture.md) for the full architecture documentation, data flows, and PTY protocol details.
See [Keyboard Handling](docs/keyboard-handling.md) for keyboard interception design.
See [Decisions](docs/decisions.md) for architecture decision records.
See [Localization](docs/localization.md) for translation guide.

See [Diagrams](docs/diagrams/) for visual flow diagrams:
- [Sidebar/Tab Architecture](docs/diagrams/sidebar-architecture.md)
- [Status Bar and Server Architecture](docs/diagrams/statusbar-flow.md)
- [Server Restart Flow](docs/diagrams/server-restart-flow.md)
- [File Attachment Flow](docs/diagrams/file-attach-flow.md)
- [IDE Context Awareness (MCP)](docs/diagrams/ide-context-awareness-flow.md)
- [MCP Error Handling](docs/diagrams/mcp-error-handling-flow.md)
