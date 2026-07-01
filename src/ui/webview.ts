import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };
declare const __LEADER_CHORDS__: string[] | undefined;

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

const el = document.getElementById("terminal")!;
term.open(el);
fitAddon.fit();

new ResizeObserver(() => {
  fitAddon.fit();
  vscode.postMessage({ type: "resize", cols: term.cols, rows: term.rows });
}).observe(el);

window.addEventListener("message", (e) => {
  if (e.data.type === "terminalData") term.write(e.data.data as string);
  if (e.data.type === "focusTerminal") term.focus();
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
  if (data === "\x18") {
    leaderActive = true;
    if (leaderTimer !== null) clearTimeout(leaderTimer);
    leaderTimer = setTimeout(clearLeader, LEADER_TIMEOUT);
  }
  vscode.postMessage({ type: "textInput", data });
});

el.addEventListener("click", () => term.focus());

el.addEventListener("focusin", () => vscode.postMessage({ type: "focusChange", focused: true }));
el.addEventListener("focusout", () => vscode.postMessage({ type: "focusChange", focused: false }));

document.addEventListener("keydown", (e: KeyboardEvent) => {
  if (e.key === "Escape" && el.contains(document.activeElement)) {
    vscode.postMessage({ type: "focusChange", focused: false });
  }
}, true);

vscode.postMessage({ type: "ready" });
