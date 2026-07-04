import * as esbuild from "esbuild";
import { readFileSync } from "fs";

const isWatch = process.argv.includes("--watch");

/** @type {esbuild.BuildOptions} */
const extensionConfig = {
  entryPoints: ["src/extension.ts"],
  bundle: true,
  outfile: "dist/extension.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["vscode", "@xterm/xterm", "@xterm/addon-fit", "@xterm/headless"],
  sourcemap: true,
  minify: false,
  logLevel: "info",
  define: {
    "process.env.EXTENSION_VERSION": JSON.stringify(
      JSON.parse(readFileSync("package.json", "utf8")).version
    ),
  },
};

/** @type {esbuild.BuildOptions} */
const webviewConfig = {
  entryPoints: ["src/ui/webview.ts"],
  bundle: true,
  outfile: "dist/webview.js",
  platform: "browser",
  format: "iife",
  target: "es2022",
  sourcemap: false,
  minify: false,
  logLevel: "info",
};

/** @type {esbuild.BuildOptions} */
const helperConfig = {
  entryPoints: ["src/ptyHelper.ts"],
  bundle: true,
  outfile: "dist/ptyHelper.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  external: ["node-pty"],
  sourcemap: false,
  minify: false,
};

/** @type {esbuild.BuildOptions} */
const watchdogConfig = {
  entryPoints: ["src/watchdog.ts"],
  bundle: true,
  outfile: "dist/watchdog.js",
  platform: "node",
  format: "cjs",
  target: "node18",
  sourcemap: false,
  minify: false,
  define: {
    "process.env.OPENCODE_IS_WATCHDOG": JSON.stringify("1"),
  },
};

async function main() {
  if (isWatch) {
    const extCtx = await esbuild.context(extensionConfig);
    const webCtx = await esbuild.context(webviewConfig);
    const helperCtx = await esbuild.context(helperConfig);
    const watchdogCtx = await esbuild.context(watchdogConfig);
    await extCtx.watch();
    await webCtx.watch();
    await helperCtx.watch();
    await watchdogCtx.watch();
    console.log("[opencode-tui] Watching for changes...");
  } else {
    await esbuild.build(extensionConfig);
    await esbuild.build(webviewConfig);
    await esbuild.build(helperConfig);
    await esbuild.build(watchdogConfig);
    console.log("[opencode-tui] Build complete.");
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
