# Localization

The extension uses VS Code's built-in `vscode.l10n` API and `package.nls` mechanism for localization.

## File layout

```
├── package.nls.json              # English source for package.json strings
├── package.nls.de.json           # German translation
├── package.nls.ru.json           # Russian translation
├── ...                           # Other locales
├── l10n/
│   ├── bundle.l10n.json          # English source for code strings
│   ├── bundle.l10n.de.json       # German translation
│   ├── bundle.l10n.ru.json       # Russian translation
│   └── ...                       # Other locales
```

## Package.json strings — `package.nls.json`

Strings in `package.json` (command titles, config descriptions, view names) use the `%key%` syntax:

```json
{
  "commands": [{
    "command": "opencode-tui-unofficial.openTerminal",
    "title": "%cmd.openTerminal.title%"
  }]
}
```

The English source is in `package.nls.json`:

```json
{
  "cmd.openTerminal.title": "OpenCode: Open Terminal"
}
```

Translations go in `package.nls.<locale>.json`:

```json
{
  "cmd.openTerminal.title": "OpenCode: Terminal öffnen"
}
```

## Code strings — `l10n/bundle.l10n.json`

User-facing strings in TypeScript code use `vscode.l10n.t()`:

```typescript
vscode.window.showErrorMessage(
  vscode.l10n.t("Failed to start OpenCode: {0}", msg)
);
```

The English source is in `l10n/bundle.l10n.json`:

```json
{
  "Failed to start OpenCode: {0}": "Failed to start OpenCode: {0}"
}
```

Translations go in `l10n/bundle.l10n.<locale>.json`:

```json
{
  "Failed to start OpenCode: {0}": "Не удалось запустить OpenCode: {0}"
}
```

## How VS Code resolves locale

1. VS Code detects the UI language from the `locale.json` setting or OS language
2. For `package.json` strings: looks for `package.nls.<locale>.json`, falls back to `package.nls.json`
3. For code strings: looks for `l10n/bundle.l10n.<locale>.json` at the extension root, falls back to `l10n/bundle.l10n.json`

VS Code automatically matches the extension locale to the VS Code UI locale.

## Adding a new locale

1. Create `package.nls.<locale>.json` with translated package.json strings
2. Create `l10n/bundle.l10n.<locale>.json` with translated code strings
3. Reference VS Code locale codes from the [Microsoft Locale Codes](https://learn.microsoft.com/en-us/openspecs/office_standards/ms-oe376/6c085406-a698-4e12-9d4d-c3b0ee3dbc4a) list

### Example: adding Turkish (tr)

```bash
cp package.nls.json package.nls.tr.json
# Translate strings in package.nls.tr.json
cp l10n/bundle.l10n.json l10n/bundle.l10n.tr.json
# Translate strings in bundle.l10n.tr.json
```

## String extraction

To extract new translatable strings from the codebase:

```bash
# Using @vscode/l10n-dev CLI:
npx @vscode/l10n-dev export --outDir l10n ./src
```

This scans for `vscode.l10n.t()` calls and updates `l10n/bundle.l10n.json`.

## Available locales

| Locale | Language | File suffix |
|--------|----------|-------------|
| en | English | `(default, no suffix)` |
| zh-cn | Chinese Simplified | `zh-cn` |
| zh-tw | Chinese Traditional | `zh-tw` |
| ja | Japanese | `ja` |
| ko | Korean | `ko` |
| de | German | `de` |
| fr | French | `fr` |
| es | Spanish | `es` |
| ru | Russian | `ru` |
| pt-br | Portuguese (Brazilian) | `pt-br` |
| it | Italian | `it` |
