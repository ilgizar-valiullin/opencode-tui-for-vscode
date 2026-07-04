import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
declare const __LEADER_CHORDS__: string[] | undefined;
declare const __CTRL_A_SELECT_ALL__: boolean | undefined;
declare const __ENTER_SENDS_MESSAGE__: boolean | undefined;

const vscode = acquireVsCodeApi();

const term = new Terminal({
  convertEol: true,
  fontSize: 14,
  fontFamily: "'Cascadia Code','Fira Code','JetBrains Mono','Consolas',monospace",
  theme: {
    background: "#0d1117", foreground: "#c9d1d9", cursor: "#58a6ff",
    black: "#161b22", red: "#f78166", green: "#3fb950", yellow: "#d29922",
    blue: "#58a6ff", magenta: "#bc8cff", cyan: "#39c5d2", white: "#b1bac4",
    brightBlack: "#30363d", brightRed: "#ffa198", brightGreen: "#56d364",
    brightYellow: "#e3b341", brightBlue: "#79c0ff", brightMagenta: "#d2a8ff",
    brightCyan: "#56d4dd", brightWhite: "#f0f6fc",
  },
});

const fitAddon = new FitAddon();
term.loadAddon(fitAddon);

let startedOnce = false;

const el = document.getElementById("terminal")!;
term.open(el);
term.attachCustomKeyEventHandler((e) => {
  if (e.type === "keydown" && e.ctrlKey && e.code === "KeyA" && __CTRL_A_SELECT_ALL__) return false;
  return true;
});
fitAddon.fit();

new ResizeObserver(() => {
  fitAddon.fit();
  vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
}).observe(el);

window.addEventListener("message", (e) => {
  if (e.data.type === "terminalData") term.write(e.data.data as string);
  if (e.data.type === "focusTerminal") term.focus();
  if (e.data.type === "settingsData") {
    const d = e.data as { opencodePath: string; serverPort: number; leaderChords: string[]; ctrlASelectAll: boolean; enterSendsMessage: boolean };
    (document.getElementById("setOpenCodePath") as HTMLInputElement).value = d.opencodePath;
    (document.getElementById("setServerPort") as HTMLInputElement).value = String(d.serverPort);
    (document.getElementById("setLeaderChords") as HTMLInputElement).value = d.leaderChords.join(",");
    (document.getElementById("setCtrlASelectAll") as HTMLInputElement).checked = d.ctrlASelectAll;
    (document.getElementById("setEnterSendsMessage") as HTMLInputElement).checked = d.enterSendsMessage;
    document.getElementById("settingsOverlay")!.classList.add("open");
  }
  if (e.data.type === "serverInfo") {
    const d = e.data as { address: string; port: number; running: boolean };
    const addrEl = document.querySelector(".addr-info")!;
    const restartBtn = document.getElementById("restartBtn") as HTMLButtonElement;
    const toggleBtn = document.getElementById("toggleBtn") as HTMLButtonElement;
    if (d.running) {
      addrEl.textContent = `Server: ${d.address}:${d.port}`;
      restartBtn.disabled = false;
      restartBtn.textContent = "Restart";
      toggleBtn.disabled = false;
      toggleBtn.textContent = "Shutdown";
      if (startedOnce) {
        term.clear();
        term.write(`\r\n\x1b[33m[Server restarted on ${d.address}:${d.port}]\x1b[0m\r\n`);
        term.focus();
        fitAddon.fit();
        vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
      }
      startedOnce = true;
    } else {
      addrEl.textContent = "Server: Stopped";
      restartBtn.disabled = true;
      restartBtn.textContent = "Restart";
      toggleBtn.disabled = false;
      toggleBtn.textContent = "Start";
      term.write(`\r\n\x1b[33m[Server stopped]\x1b[0m\r\n`);
    }
  }
});

const LEADER_TIMEOUT = 2000;
const leaderChords = new Set<string>(
  __LEADER_CHORDS__ ?? ["n","l","c","x","g","m","a","e","t","s","b","h","y","u","r","q"],
);
let leaderActive = false;
let leaderTimer: ReturnType<typeof setTimeout> | null = null;

function codeToAscii(code: string, shift: boolean): string | null {
  if (code.startsWith("Key")) {
    const letter = code.slice(3).toLowerCase();
    if (letter.length === 1 && /[a-z]/.test(letter)) return letter;
    return null;
  }
  if (code.startsWith("Digit")) {
    const digit = code.slice(5);
    if (shift) {
      const shifted: Record<string, string> = {
        "0": ")", "1": "!", "2": "@", "3": "#", "4": "$",
        "5": "%", "6": "^", "7": "&", "8": "*", "9": "(",
      };
      return shifted[digit] ?? null;
    }
    return digit;
  }
  const simple: Record<string, string> = {
    Minus: "-", Equal: "=", BracketLeft: "[", BracketRight: "]",
    Semicolon: ";", Quote: "'", Comma: ",", Period: ".", Slash: "/",
    Backquote: "`", Backslash: "\\", Space: " ", IntlBackslash: "\\",
  };
  if (code in simple) return simple[code];
  return null;
}

function clearLeader() {
  leaderActive = false;
  if (leaderTimer !== null) {
    clearTimeout(leaderTimer);
    leaderTimer = null;
  }
}

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (!leaderActive) return;
  if (!el.contains(e.target as Node)) return;
  if (e.code === "Escape") {
    clearLeader();
    return;
  }
  const ascii = codeToAscii(e.code, e.shiftKey);
  if (ascii === null || e.ctrlKey || e.altKey || e.metaKey) return;
  if (!leaderChords.has(ascii)) return;
  e.preventDefault();
  e.stopPropagation();
  clearLeader();
  vscode.postMessage({ type: "textInput", data: ascii });
}, true);

term.onData((data: string) => {
  if (data === "\x01" && __CTRL_A_SELECT_ALL__) {
    vscode.postMessage({ type: "selectAll" });
    return;
  }
  if (data === "\x18") {
    leaderActive = true;
    if (leaderTimer !== null) clearTimeout(leaderTimer);
    leaderTimer = setTimeout(clearLeader, LEADER_TIMEOUT);
  }
  if (data === "\x16") {
    vscode.postMessage({ type: "clipboardPaste" });
  }
  vscode.postMessage({ type: "textInput", data });
});

el.addEventListener("click", () => term.focus());

el.addEventListener("focusin", () => vscode.postMessage({ type: "focusChange", focused: true }));
el.addEventListener("focusout", () => vscode.postMessage({ type: "focusChange", focused: false }));

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if ((e.ctrlKey || e.metaKey) && e.code === "KeyA" && __CTRL_A_SELECT_ALL__) {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: "selectAll" });
    return;
  }
  if (e.code === "Enter" && el.contains(e.target as Node) && !e.ctrlKey && !e.altKey && !e.metaKey && !leaderActive) {
    e.preventDefault();
    e.stopPropagation();
    const enterSends = __ENTER_SENDS_MESSAGE__ !== false;
    const shouldSend = enterSends ? !e.shiftKey : e.shiftKey;
    vscode.postMessage({ type: "textInput", data: shouldSend ? "\r" : "\n" });
    return;
  }
  if (e.key === "Escape" && el.contains(document.activeElement)) {
    vscode.postMessage({ type: "focusChange", focused: false });
  }
}, true);

document.addEventListener("paste", (e: ClipboardEvent) => {
  const text = e.clipboardData?.getData("text/plain");
  if (text) {
    e.preventDefault();
    e.stopPropagation();
    vscode.postMessage({ type: "textInput", data: `\x1b[200~${text}\x1b[201~` });
    setTimeout(() => term.focus(), 0);
    return;
  }
  e.stopPropagation();
  vscode.postMessage({ type: "clipboardPaste" });
  setTimeout(() => term.focus(), 0);
}, true);

document.getElementById("restartBtn")!.addEventListener("click", () => {
  vscode.postMessage({ type: "restartServer" });
});

document.getElementById("toggleBtn")!.addEventListener("click", () => {
  vscode.postMessage({ type: "toggleServer" });
});

document.getElementById("settingsBtn")!.addEventListener("click", () => {
  vscode.postMessage({ type: "openSettings" });
});

document.getElementById("settingsSaveBtn")!.addEventListener("click", () => {
  const chords = (document.getElementById("setLeaderChords") as HTMLInputElement).value;
  vscode.postMessage({
    type: "saveSettings",
    opencodePath: (document.getElementById("setOpenCodePath") as HTMLInputElement).value,
    serverPort: parseInt((document.getElementById("setServerPort") as HTMLInputElement).value, 10) || 0,
    leaderChords: chords.split(",").map((s) => s.trim()).filter(Boolean),
    ctrlASelectAll: (document.getElementById("setCtrlASelectAll") as HTMLInputElement).checked,
    enterSendsMessage: (document.getElementById("setEnterSendsMessage") as HTMLInputElement).checked,
  });
  document.getElementById("settingsOverlay")!.classList.remove("open");
});

document.getElementById("settingsCancelBtn")!.addEventListener("click", () => {
  document.getElementById("settingsOverlay")!.classList.remove("open");
});

document.getElementById("settingsOverlay")!.addEventListener("click", (e) => {
  if (e.target === e.currentTarget) document.getElementById("settingsOverlay")!.classList.remove("open");
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && document.getElementById("settingsOverlay")!.classList.contains("open")) {
    document.getElementById("settingsOverlay")!.classList.remove("open");
  }
});

vscode.postMessage({ type: "ready" });
