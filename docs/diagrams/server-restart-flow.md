# Server Restart Flow

## Sequence Diagram

```mermaid
sequenceDiagram
    participant User as User Click
    participant Webview as Webview (xterm.js)
    participant ExtHost as Extension Host
    participant Helper as PTY Helper
    participant OC as opencode Process

    User->>Webview: Click "Restart" button
    Webview->>ExtHost: postMessage({ type: "restartServer" })
    
    rect rgb(200, 30, 30, 0.1)
        Note over ExtHost: BEFORE FIX: old exit() handler<br/>fires async and nullifies<br/>new helper_/client_ refs
    end
    
    ExtHost->>ExtHost: serverManager.stop()
    ExtHost->>Helper: stdin: {"type":"kill"}
    ExtHost->>Helper: helper_.kill()
    ExtHost-->>Helper: helper_ = null
    
    Helper-->>OC: SIGTERM (process tree)
    Note over Helper,OC: Exit event fires async (next tick)
    
    ExtHost->>ExtHost: serverManager.start() on new port
    ExtHost->>ExtHost: spawn new PTY helper
    ExtHost->>ExtHost: proc.on("exit") — guards this.helper_ === proc
    
    rect rgb(30, 120, 30, 0.1)
        Note over ExtHost: AFTER FIX: exit handler checks<br/>"if (this.helper_ === proc)"<br/>→ does NOT wipe new ref
    end
    
    ExtHost-->>Helper: this.helper_ = proc (new process)
    ExtHost->>Helper: stdin: spawn message
    Helper->>OC: spawn opencode on new port
    OC-->>ExtHost: health OK → new OpenCodeClient
    
    ExtHost->>Webview: postMessage serverInfo (new port, running:true)
    Webview->>Webview: term.clear(), term.write(), fitAddon.fit()
    Webview->>ExtHost: postMessage resize(cols, rows)
    ExtHost->>Helper: resizePty(cols, rows) — works (helper_ is current proc)
    
    User->>Webview: Type text
    Webview->>ExtHost: postMessage textInput
    ExtHost->>Helper: writeToStdin(data) — works (helper_ is current proc)
```

## State Diagram

```mermaid
stateDiagram-v2
    [*] --> Idle: extension activated
    Idle --> Starting: webview ready
    Starting --> Running: health OK
    
    Running --> Restarting: user clicks Restart
    Restarting --> StoppingOld: serverManager.stop()
    StoppingOld --> StartingNew: old process killed
    StartingNew --> Running: health OK on new port
    
    Running --> Stopped: user clicks Shutdown
    Stopped --> Starting: user clicks Start
    
    Running --> Crashed: unexpected exit
    Crashed --> Starting: auto/manual restart
```

## Race Condition (Before Fix)

```mermaid
sequenceDiagram
    participant ExtHost as Extension Host
    participant OldProc as Old Helper (PID A)
    participant NewProc as New Helper (PID B)

    ExtHost->>OldProc: kill()
    ExtHost->>ExtHost: this.helper_ = null
    
    ExtHost->>ExtHost: this.helper_ = spawn(pid B)
    ExtHost->>NewProc: exit handler: if (this.helper_ === pidB) → nullify
    
    Note over OldProc: exit event fires (async)
    OldProc->>ExtHost: exit handler RUNS with this.helper_ === pid B??<br/>handler: this.helper_ = null, this.client_ = null
    Note over ExtHost: BUG! New refs wiped by old exit handler
```

After the fix, the old exit handler checks `this.helper_ === proc` (captured local ref), so it only nullifies if the current helper is still the same process that exited.
