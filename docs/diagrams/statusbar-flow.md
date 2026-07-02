# Status Bar and Server Architecture Flow

## Architecture Overview

```mermaid
flowchart TB
    subgraph Extension["Extension Host"]
        Provider["OpenCodeWebviewProvider"]
        MCP["MCP Server (shared)"]
    end

    subgraph Sidebar["Sidebar Webview"]
        SW["webview.ts"]
        SSM["OpenCodeServerManager #1"]
        SPTY["PTY Helper #1"]
        SOC["opencode --port X"]
    end

    subgraph Tab["Tab Webview"]
        TW["webview.ts"]
        TSM["OpenCodeServerManager #2"]
        TPTY["PTY Helper #2"]
        TOC["opencode --port Y"]
    end

    Provider --> SW
    Provider --> TW
    SW --> SSM
    TW --> TSM
    SSM --> SPTY
    TSM --> TPTY
    SPTY --> SOC
    TPTY --> TOC
    MCP -.->|"mcpPort"| SSM
    MCP -.->|"mcpPort"| TSM
```

## Server Lifecycle per Webview

```mermaid
sequenceDiagram
    participant User
    participant WV as Webview (sidebar or tab)
    participant Prov as WebviewProvider
    participant SM as ServerManager (per-webview)
    participant PTY as PTY Helper

    Note over WV,PTY: Each webview creates its own ServerManager

    WV->>Prov: { type: "ready" }
    Prov->>Prov: Create new OpenCodeServerManager
    Prov->>SM: setMcpPort(mcpPort)
    Prov->>SM: start(openCodePath, port, cwd)
    SM->>PTY: spawn node ptyHelper.js
    PTY->>PTY: spawn opencode --port X
    PTY-->>SM: R{pid}
    SM->>SM: pollHealth() until healthy
    SM-->>Prov: ready
    Prov-->>WV: { type: "serverInfo", port, running: true }

    Note over WV,PTY: Restart (only affects this webview's server)
    User->>WV: Click "Restart"
    WV->>Prov: { type: "restartServer" }
    Prov->>SM: stop()
    Prov->>SM: start(...)
    SM-->>Prov: ready
    Prov-->>WV: { type: "serverInfo", port, running: true }

    Note over WV,PTY: Focus tracking
    WV->>Prov: { type: "focusChange", focused: true }
    Prov->>Prov: activeServer_ = this server
```

## State Diagram (per webview)

```mermaid
stateDiagram-v2
    [*] --> Starting: webview ready
    Starting --> Running: server starts
    Starting --> Stopped: start fails

    Running --> Running: Restart (stop + start)
    Running --> Stopped: Shutdown (btn)

    Stopped --> Running: Start (btn)
    Stopped --> [*]: webview disposed

    Running --> Settings: gear btn
    Stopped --> Settings: gear btn
    Settings --> Running: close (Cancel/Escape/backdrop)
    Settings --> Stopped: close (Cancel/Escape/backdrop)
    Settings --> Running: Save (changes applied, overlay closed)
    Settings --> Stopped: Save (changes applied, overlay closed)
```

## Settings Modal Layout

```
+----------------------------------+
| Settings                         |
|                                  |
| OpenCode Path                    |
| [  ____________________________]|
|                                  |
| Server Port (0 = auto)           |
| [  ____________________________]|
|                                  |
| Leader Chords (comma separated)  |
| [  ____________________________]|
|                                  |
| [x] Ctrl+A Select All (fix)      |
|                                  |
|              [Cancel]  [Save]    |
+----------------------------------+
```
