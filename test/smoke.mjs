import { strict as assert } from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(dir, "..");

let passed = 0;
let failed = 0;

function test(name, fn) {
  try {
    fn();
    passed++;
    console.log(`  ✅ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ❌ ${name}: ${e.message}`);
  }
}

function read(file) {
  return readFileSync(path.join(root, file), "utf-8");
}

function exists(file) {
  return existsSync(path.join(root, file));
}

console.log("\n── Build output ──\n");

test("dist/extension.js exists", () => assert(exists("dist/extension.js"), "missing extension.js"));
test("dist/webview.js exists", () => assert(exists("dist/webview.js"), "missing webview.js"));
test("dist/ptyHelper.js exists", () => assert(exists("dist/ptyHelper.js"), "missing ptyHelper.js"));

console.log("\n── Package.json ──\n");

test("package.json is valid JSON", () => {
  const pkg = JSON.parse(read("package.json"));
  assert(pkg.name, "no name");
  assert(pkg.version, "no version");
  assert(pkg.main, "no main");
});

test("name matches repo convention", () => {
  const pkg = JSON.parse(read("package.json"));
  assert(pkg.name === "opencode-tui-for-vscode", `unexpected name: ${pkg.name}`);
});

test("version is semver", () => {
  const pkg = JSON.parse(read("package.json"));
  assert(/^\d+\.\d+\.\d+$/.test(pkg.version), `invalid version: ${pkg.version}`);
});

test("all referenced icons exist", () => {
  const pkg = JSON.parse(read("package.json"));
  const refs = [pkg.contributes?.viewsContainers?.secondarySidebar?.[0]?.icon];
  const cmdIcon = pkg.contributes?.commands?.[0]?.icon;
  if (cmdIcon?.light) refs.push(cmdIcon.light);
  if (cmdIcon?.dark) refs.push(cmdIcon.dark);
  for (const ref of refs.filter(Boolean)) {
    assert(exists(ref), `missing icon: ${ref}`);
  }
});

console.log("\n── Localization ──\n");

test("package.nls.json exists", () => assert(exists("package.nls.json"), "missing package.nls.json"));

test("all locale files have matching keys", () => {
  const en = JSON.parse(read("package.nls.json"));
  const enKeys = Object.keys(en).sort();
  for (const f of ["zh-cn", "zh-tw", "ja", "ko", "de", "fr", "es", "ru", "pt-br", "it"]) {
    const file = `package.nls.${f}.json`;
    if (!exists(file)) { console.log(`  ⚠ ${file} missing`); continue; }
    const locale = JSON.parse(read(file));
    const keys = Object.keys(locale).sort();
    assert.deepEqual(keys, enKeys, `${file}: keys mismatch`);
  }
});

test("l10n/bundle.l10n.json exists", () => assert(exists("l10n/bundle.l10n.json"), "missing bundle.l10n.json"));

console.log("\n── TypeScript ──\n");

test("tsc --noEmit passes", () => {
  execSync("npx tsc --noEmit", { cwd: root, stdio: "pipe", timeout: 30000 });
});

console.log("\n── Source files ──\n");

test("all source files compile (no JS in src/)", () => {
  const jsFiles = execSync('dir /s /b src\\*.js 2>nul || echo none', { cwd: root, encoding: "utf8", timeout: 5000 }).trim();
  if (jsFiles && jsFiles !== "none") {
    console.log(`  ⚠ JS files in src/: ${jsFiles}`);
  }
});

test("all package.nls.* keys have %key% references in package.json", () => {
  const pkg = read("package.json");
  const nls = JSON.parse(read("package.nls.json"));
  for (const key of Object.keys(nls)) {
    const ref = `%${key}%`;
    assert(pkg.includes(ref), `missing %${key}% ref in package.json`);
  }
});

// ─── Summary ───

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
