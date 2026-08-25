import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const windows = process.platform === "win32";
const npm = windows ? "npm.cmd" : "npm";
const python = process.env.MIRRORORDER_PYTHON || (windows ? "python" : "python3");
const cargo = process.env.CARGO || "cargo";

function fail(message) {
  console.error(`\nRC verification failed: ${message}`);
  process.exit(1);
}

function commandAvailable(command, args = ["--version"]) {
  const result = spawnSync(command, args, { cwd: repoRoot, encoding: "utf8", windowsHide: true });
  return !result.error && result.status === 0;
}

function run(label, command, args, cwd) {
  console.log(`\n=== ${label} ===`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
    env: process.env,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}`);
}

if (!fs.existsSync(path.join(desktopRoot, "node_modules"))) {
  fail("desktop/node_modules 不存在；先在 desktop/ 执行 npm install。验证脚本不会自动联网安装依赖。");
}
if (!commandAvailable(npm)) fail("npm 不可用");
if (!commandAvailable(python, ["--version"])) fail(`Python 不可用：${python}`);
if (!commandAvailable(cargo)) fail("cargo 不可用；Rust/Tauri release gate 不能被跳过或伪装成通过");

run("Development baseline gate", npm, ["run", "check:baseline"], desktopRoot);
run("TypeScript strict typecheck", npm, ["run", "typecheck"], desktopRoot);
run("Vitest", npm, ["test"], desktopRoot);
run("Vite production build", npm, ["run", "build"], desktopRoot);
run(
  "Rust Timeline Core tests",
  cargo,
  ["test", "--manifest-path", "src-tauri/crates/timeline-core/Cargo.toml"],
  desktopRoot,
);
run(
  "Tauri host Rust tests",
  cargo,
  ["test", "--manifest-path", "src-tauri/Cargo.toml"],
  desktopRoot,
);
run(
  "Tauri host cargo check",
  cargo,
  ["check", "--manifest-path", "src-tauri/Cargo.toml"],
  desktopRoot,
);
run("Python compileall", python, ["-m", "compileall", "-q", "src/script_organizer"], repoRoot);
run("Python pytest", python, ["-m", "pytest", "-q"], repoRoot);

console.log("\nDesktop local RC source gates passed.");
console.log("Packaged macOS/Windows runtime, real media, LAN and FCP/installer smoke gates remain separate native requirements.");
