# MCP Server Error Handling Flow

```mermaid
sequenceDiagram
    participant O as OpenCode CLI
    participant H as @hono/node-server
    participant T as StreamableHTTP Transport
    participant P as Protocol (SDK)
    participant M as McpServer
    participant E as Extension

    O->>H: POST /mcp (initialize)
    H->>T: handleRequest()
    T->>P: connect()
    P->>M: register handlers
    M-->>O: session initialized

    Note over O,E: Editor state changes trigger notification

    E->>M: notifyContextChanged()
    M->>P: sendResourceUpdated()
    P->>T: send(notification)

    alt Client connected (SSE stream open)
        T->>O: writeSSEEvent() via SSE
        O-->>T: OK
    else Client disconnected (SSE stream closed)
        T->>T: writeSSEEvent() fails
        T->>T: onerror() called (noop - silenced)
        T-->>P: error caught by .catch()
        P-->>M: rejection handled
        M->>E: sessions.delete(id)
    end

    alt Unhandled path (no .catch on protocol)
        T--xP: rejection propagates
        P--xE: unhandledRejection
        E->>E: process.on('unhandledRejection') suppresses
    end
```

```mermaid
flowchart TD
    A[Editor state changes] --> B[debounce 150ms]
    B --> C{notifyContextChanged}
    C --> D[Iterate sessions Map]
    D --> E[sendResourceUpdated]
    E --> F{transport.send}
    F -->|SSE stream open| G[write to stream]
    F -->|SSE stream closed| H[writeSSEEvent throws<br/>onerror noop]
    H --> I[catch + sessions.delete]
    I --> J[Promise.allSettled]
    G --> J
    J --> K[Done - next session]
    
    L[staleSessionCleanup] -->|every 30s| M[check sessionId]
    M -->|falsy| N[sessions.delete]
    
    X[opencode exits] --> Y[PTY helper exit event]
    Y --> Z[mcpDisconnectCallback]
    Z --> AA[sessionsClose]
    AA --> AB[close all sessions]
    AB --> AC[no stale SSE streams = no errors]
```

## Changes Made

### `src/extension.ts`
- Added `serverManager.onMcpClientDisconnect()` — when opencode stops, closes all MCP sessions immediately, preventing stale SSE streams

### `src/opencodeServer.ts`
- Added `onMcpClientDisconnect()` method and callback — triggered when PTY helper exits, opencode stops, or PTY errors occur
- The callback fires in three places: exit, stop, and PTY error

### `src/mcp-server.ts`
- Added `transport.onerror = () => {}` — silences SSE stream write errors in the transport layer
- Wrapped HTTP request handler in try/catch — prevents unhandled async rejections from `http.createServer`
- Added periodic stale session cleanup (30s interval) — removes sessions whose `sessionId` is falsy (disconnected)
- Added `sessionsClose()` method to `McpServerHandle` — closes all active sessions without stopping the HTTP server, allowing clean reconnection
