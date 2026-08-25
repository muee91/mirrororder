import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const bundleRoot = path.join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos");

function fail(message) {
  console.error(`macOS bundle verification failed: ${message}`);
  process.exit(1);
}

function run(command, args, label, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", ...options });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) fail(`${label} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  return (result.stdout || "").trim();
}

function findApp() {
  if (!fs.existsSync(bundleRoot)) fail(`bundle directory not found: ${bundleRoot}`);
  const apps = fs.readdirSync(bundleRoot).filter((name) => name.endsWith(".app"));
  if (apps.length !== 1) fail(`expected exactly one .app in ${bundleRoot}; found ${apps.join(", ") || "none"}`);
  return path.join(bundleRoot, apps[0]);
}

function assertFile(value, label) {
  if (!fs.existsSync(value) || !fs.statSync(value).isFile()) fail(`${label} missing: ${value}`);
}

function inspectMachO(binary, appRoot) {
  const output = run("otool", ["-L", binary], `otool ${path.basename(binary)}`);
  const forbidden = [];
  for (const raw of output.split(/\r?\n/).slice(1)) {
    const dependency = raw.trim().split(" (compatibility")[0];
    if (!dependency) continue;
    const allowed =
      dependency.startsWith("@rpath/") ||
      dependency.startsWith("@loader_path/") ||
      dependency.startsWith("@executable_path/") ||
      dependency.startsWith("/usr/lib/") ||
      dependency.startsWith("/System/Library/") ||
      dependency.startsWith(appRoot);
    if (!allowed) forbidden.push(dependency);
  }
  if (forbidden.length) {
    fail(`${binary} has build-machine dylib dependencies: ${forbidden.join(", ")}`);
  }
}

if (process.platform !== "darwin") fail("this verification gate must run on macOS");

const app = findApp();
const resources = path.join(app, "Contents", "Resources");
const core = path.join(resources, "mirrororder-core");
const pythonRoot = path.join(resources, "mirrororder-python");
const tools = path.join(resources, "mirrororder-tools", "bin");
const manifestPath = path.join(resources, "mirrororder-runtime", "mirrororder-runtime-manifest.json");
assertFile(manifestPath, "runtime manifest");

let manifest;
try {
  manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
} catch (error) {
  fail(`invalid runtime manifest: ${error.message}`);
}
if (manifest.contract !== "mirrororder_packaged_runtime.v1") fail(`unexpected runtime contract: ${manifest.contract}`);
if (manifest.platform !== "darwin") fail(`runtime was staged for ${manifest.platform}, not darwin`);
if (!manifest.python?.executable) fail("runtime manifest has no python executable");

const python = path.join(pythonRoot, manifest.python.executable);
const ffmpeg = path.join(tools, "ffmpeg");
const ffprobe = path.join(tools, "ffprobe");
for (const [value, label] of [[python, "portable Python"], [ffmpeg, "ffmpeg"], [ffprobe, "ffprobe"]]) {
  assertFile(value, label);
}

const source = path.join(core, "src");
const multicam = path.join(core, "vendor", "multicam-audio-sync");
if (!fs.existsSync(path.join(source, "script_organizer"))) fail("bundled Python Core missing script_organizer");
if (!fs.existsSync(path.join(multicam, "scripts"))) fail("bundled multicam engine missing scripts");

const probe = [
  "import json, os, sys",
  `sys.path.insert(0, ${JSON.stringify(source)})`,
  "import script_organizer.cli",
  "import numpy, pandas, scipy",
  "print(json.dumps({'python': sys.version.split()[0], 'executable': sys.executable, 'prefix': sys.prefix}))",
].join("; ");
const pythonOutput = run(python, ["-I", "-c", probe], "bundled Python/Core probe", {
  env: {
    ...process.env,
    PATH: `${tools}${path.delimiter}/usr/bin:/bin:/usr/sbin:/sbin`,
    MIRRORORDER_PACKAGED_RUNTIME: "1",
    MIRRORORDER_MULTICAM_SYNC_ROOT: multicam,
  },
});
run(ffmpeg, ["-version"], "bundled ffmpeg probe");
run(ffprobe, ["-version"], "bundled ffprobe probe");

inspectMachO(python, app);
inspectMachO(ffmpeg, app);
inspectMachO(ffprobe, app);

const executableDir = path.join(app, "Contents", "MacOS");
const appExecutables = fs.readdirSync(executableDir).map((name) => path.join(executableDir, name)).filter((item) => fs.statSync(item).isFile());
if (!appExecutables.length) fail("app bundle has no Contents/MacOS executable");
for (const executable of appExecutables) inspectMachO(executable, app);

if (process.env.MIRRORORDER_REQUIRE_CODESIGN === "1") {
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", app], "codesign verification");
}

console.log(`macOS bundle gate passed: ${app}`);
console.log(`runtime: ${pythonOutput}`);
console.log(`codesign gate: ${process.env.MIRRORORDER_REQUIRE_CODESIGN === "1" ? "required and passed" : "not required for this local build"}`);
console.log("Final Cut import, real-media playback, multicam sync and LAN second-device smoke remain explicit native gates.");
