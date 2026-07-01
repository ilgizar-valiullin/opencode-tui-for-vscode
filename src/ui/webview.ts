import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

declare const acquireVsCodeApi: () => { postMessage(msg: unknown): void };

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
});

term.onData((data: string) => {
  vscode.postMessage({ type: "textInput", data });
});

el.addEventListener("click", () => term.focus());

vscode.postMessage({ type: "ready" });
