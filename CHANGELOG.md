# Changelog

## [1.5.5] — 2026-07-05

### Fixed

- macOS: `posix_spawnp failed` error — node-pty ships `spawn-helper` without
  execute permission (644), causing failure when VSIX extracts it. Fixed by
  `chmodSync(0o755)` on spawn-helper at helper startup.
  See node-pty#850 and node-pty#866.

### Changed

- Universal VSIX (single build, no `--target` matrix)
- `resolveOcPath` resolves `opencode` via `which`/`where` with extended PATH
  (`/opt/homebrew/bin`, `/usr/local/bin`, `~/.npm-global/bin`, `~/.local/bin`)
- CI simplified to ubuntu only
- All locale files synced with matching keys
- `spawn-helper` included in VSIX via `.vscodeignore`

## [1.5.2] — 2026-07-04

### Added

- Settings toggle for Enter/Shift+Enter behavior (send vs. newline)
- Two-line descriptions for checkbox settings in the settings modal
- l10n translations for all new strings across 11 locales

### Changed

- Ctrl+A OFF description now reads "beginning of line like in bash"

## [1.5.1] — 2026-07-03

### Fixed

- Right-click paste no longer loses terminal focus; refocus via `setTimeout(() => term.focus(), 0)` after paste event

## [1.5.0] — 2026-07-02

### Changed

- Refactor server lifecycle: separate sidebar and tab server instances
- Remove global `serverManager` singleton — commands use `provider!.stopAllServers()`
- Attach file/selection commands now require active server context
- Extension.ts uses `provider!` pattern for command registrations

## [1.4.0] — 2026-07-02

### Added

- Settings button (gear) in the status bar next to Restart
- Settings modal with fields for OpenCode Path, Server Port, Leader Chords, Ctrl+A Select All
- Settings persistence via VS Code configuration API (ConfigurationTarget.Global)
- Multi-language l10n support for the settings modal (11 locales)

## [1.2.0] — 2026-07-02

### Added

- Focus toggle: `Ctrl+Shift+'` switches between editor and OpenCode panel
- Focus tracking via webview focusin/focusout/escape events
- ESLint configuration with TypeScript rules
- CI: GitHub Actions workflow (typecheck, lint, build, test, package VSIX)
- docs/architecture.md — architecture documentation
- docs/keyboard-handling.md — keyboard handling design
- docs/localization.md — localization guide
- docs/decisions.md — architecture decision records (10 ADRs)

### Changed

- CI: test step moved after build (was failing on fresh checkout)
- findNode() now searches PATH on Linux/macOS instead of falling back to Electron
- writeToStdin/resizePty use if-guard instead of && short-circuit

### Fixed

- Unused import in httpClient.ts removed
- No Electron ABI fallback for node-pty — clean error if system Node.js not found

## [1.1.1] — 2026-07-02

### Added

- i18n: package.nls.json + 10 locale files (zh-cn, zh-tw, ja, ko, de, fr, es, ru, pt-br, it)
- i18n: l10n/bundle.l10n.json + 10 locale files for code strings
- vscode.l10n.t() for error messages
- System Node.js detection on Linux/macOS (via PATH lookup)
- VS Code error notification when Node.js is not found
- CI: GitHub Actions workflow (typecheck, lint, test, build, package VSIX)
- ESLint config with TypeScript rules
- test/smoke.mjs — 13 smoke tests (build output, package.json, icons, locale, tsc)
- docs/architecture.md — architecture documentation
- docs/keyboard-handling.md — keyboard handling design
- docs/localization.md — localization guide
- docs/decisions.md — architecture decision records (10 ADRs)

### Changed

- Extension name: `opencode-tui-unofficial` → `opencode-tui-for-vscode`
- Display name: `OpenCode TUI Integration` → `OpenCode TUI for VS Code`
- Repository renamed to `opencode-tui-for-vscode`
- Command title: `OpenCode: Attach File` → `Attach to OpenCode`
- findNode() now searches PATH on Linux/macOS instead of falling back to Electron
- writeToStdin/resizePty use if-guard instead of && short-circuit

### Fixed

- No Electron ABI fallback for node-pty — clean error if system Node.js not found
- Unused import in httpClient.ts removed

## [1.1.0] — 2026-06

### Changed

- Updated package.nls.json references for localization

## [1.0.0] — 2025-06

### Added

- Initial release
- OpenCode TUI in VS Code webview panel
- event.code-based keyboard interception (Cyrillic/Korean/Japanese support)
- Leader key (Ctrl+X) + chord mapping via HTTP API
- node-pty based terminal emulation via separate helper process
- Attach file/selection commands
- MCP server for IDE context awareness
- Sidebar view + tab support
- Auto-detect opencode.exe on Windows
