# Sidebar / Tab Architecture

## View Location

```mermaid
flowchart TB
    subgraph VS_Code["VS Code — Right Sidebar (secondarySidebar)"]
        Container["opencode-tui container<br/>registered via viewsContainers.secondarySidebar<br/>icon: images/opencode-icon.svg"]
        View["opencode-tui.view<br/>type: webview, name: Terminal"]
        Container -->|contains| View
    end

    subgraph VS_Code_Left["VS Code — Left Sidebar"]
        PrimarySidebar["Explorer / Search / SCM / …<br/>(OpenCode NOT here)"]
    end

    View -->|visible → auto| Provider
    Cmd["Ctrl+Shift+P → OpenCode: Open Terminal"] -->|openTerminal| TabMethod
    StatusBar["Status Bar icon"] -->|openTerminal| TabMethod
    TabMethod -->|creates| TabPanel

    subgraph Extension["Extension Host"]
        Provider["OpenCodeWebviewProvider<br/>implements WebviewViewProvider<br/>registered for opencode-tui.view"]
        TabMethod["openInTab()<br/>creates WebviewPanel<br/>ViewColumn.Beside"]
    end

    Server["OpenCodeServerManager<br/>+ PTY helper<br/>(singleton)"]
    Provider -->|on 'ready' msg| Server
    TabPanel -->|on 'ready' msg| Server
```

## package.json contributions

```json
"viewsContainers": {
  "secondarySidebar": [
    {
      "id": "opencode-tui",
      "title": "OpenCode",
      "icon": "images/opencode-icon.svg"
    }
  ]
},
"views": {
  "opencode-tui": [
    {
      "type": "webview",
      "id": "opencode-tui.view",
      "name": "Terminal"
    }
  ]
}
```

Key points:
- `secondarySidebar` (lowercase `b`) — the correct key per VS Code source (`src/vs/workbench/api/browser/viewsExtensionPoint.ts`)
- PR [#261619](https://github.com/microsoft/vscode/pull/261619) merged August 25, 2025 — stable API since VS Code ~1.96
- No `enabledApiProposals` needed — API is final
- No `activitybar` entry — container lives only in the right sidebar

## Provider lifecycle

```mermaid
stateDiagram-v2
    [*] --> activate : extension starts
    activate --> registered : registerWebviewViewProvider('opencode-tui.view')
    registered --> visible : user opens\nsecondary sidebar
    visible --> running : webview sends 'ready'\nserverManager.start()
    running --> running : normal I/O
    running --> hidden : user closes\nsecondary sidebar
    hidden --> visible : user reopens

    state "Tab fallback" as tab {
        [*] --> openInTab : openTab / openTerminal command
        openInTab --> TabActive : WebviewPanel\n(ViewColumn.Beside)
        TabActive --> running : 'ready' msg
    }
```

## Key design

- `viewsContainers.secondarySidebar` — container registered directly in the right sidebar (stable API since VS Code 1.96)
- `WebviewViewProvider` registered with view id `opencode-tui.view`
- Both sidebar view and tab panel share same `serverManager` singleton
- `openTerminal`/`openTab` → `openInTab()` as tab fallback for users who want Beside-column view
- `retainContextWhenHidden: true` on sidebar keeps terminal alive when collapsed
