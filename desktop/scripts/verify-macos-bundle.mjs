import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { assertManifestToolMatches, buildToolMetadata } from "./runtime-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const bundleRoot = path.join(desktopRoot, "src-tauri", "target", "release", "bundle", "macos");
const canonicalIcon = path.join(repoRoot, "branding", "app-icon.png");
const generatedIcns = path.join(desktopRoot, "src-tauri", "icons", "generated", "icon.icns");
const EXPECTED_BRAND_ICON_GIT_BLOB = "6ec6f9e08cb89c43a1cb09385ace7c88832bf0b8";

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

function sha256(value) {
  return crypto.createHash("sha256").update(fs.readFileSync(value)).digest("hex");
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

assertFile(canonicalIcon, "canonical branded app icon");
const canonicalIconBlob = run("git", ["hash-object", canonicalIcon], "canonical branded app icon git hash", { cwd: repoRoot });
if (canonicalIconBlob !== EXPECTED_BRAND_ICON_GIT_BLOB) {
  fail(`canonical branded app icon changed unexpectedly: expected git blob ${EXPECTED_BRAND_ICON_GIT_BLOB}, got ${canonicalIconBlob}`);
}
assertFile(generatedIcns, "generated macOS app icon");

const app = findApp();
const infoPlist = path.join(app, "Contents", "Info.plist");
const resources = path.join(app, "Contents", "Resources");
assertFile(infoPlist, "app Info.plist");
const configuredIconName = run("plutil", ["-extract", "CFBundleIconFile", "raw", infoPlist], "CFBundleIconFile");
if (!configuredIconName) fail("Info.plist has an empty CFBundleIconFile");
const packagedIconName = path.extname(configuredIconName) ? configuredIconName : `${configuredIconName}.icns`;
if (path.extname(packagedIconName).toLowerCase() !== ".icns") {
  fail(`CFBundleIconFile must resolve to an .icns resource on macOS; got ${configuredIconName}`);
}
const packagedIcon = path.join(resources, packagedIconName);
assertFile(packagedIcon, "packaged macOS app icon");
const generatedIconSha256 = sha256(generatedIcns);
const packagedIconSha256 = sha256(packagedIcon);
if (generatedIconSha256 !== packagedIconSha256) {
  fail(`packaged macOS app icon does not match generated branded icon: generated=${generatedIconSha256} packaged=${packagedIconSha256}`);
}

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
if (typeof manifest.tools?.source !== "string" || !manifest.tools.source.trim()) fail("runtime manifest has no media tool source/provenance");
if (typeof manifest.tools?.provenance !== "string" || !manifest.tools.provenance.trim()) fail("runtime manifest has no media tool provenance");
if (typeof manifest.tools?.license_classification !== "string" || !manifest.tools.license_classification.trim()) fail("runtime manifest has no media tool license classification");
if (manifest.tools.redistributable !== true) fail("runtime manifest does not mark media tools redistributable");

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
let ffmpegMetadata;
let ffprobeMetadata;
try {
  ffmpegMetadata = buildToolMetadata({
    toolName: "ffmpeg",
    output: run(ffmpeg, ["-version"], "bundled ffmpeg probe"),
    filePath: ffmpeg,
    source: manifest.tools.source,
    licenseClassification: manifest.tools.license_classification,
  });
  ffprobeMetadata = buildToolMetadata({
    toolName: "ffprobe",
    output: run(ffprobe, ["-version"], "bundled ffprobe probe"),
    filePath: ffprobe,
    source: manifest.tools.source,
    licenseClassification: manifest.tools.license_classification,
  });
  assertManifestToolMatches("ffmpeg", manifest.tools.ffmpeg, ffmpegMetadata);
  assertManifestToolMatches("ffprobe", manifest.tools.ffprobe, ffprobeMetadata);
} catch (error) {
  fail(`media tool redistribution policy: ${error.message}`);
}

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
console.log(`app icon: source_blob=${canonicalIconBlob} · packaged=${packagedIconName} · sha256=${packagedIconSha256}`);
console.log(`runtime: ${pythonOutput}`);
console.log(`ffmpeg: ${ffmpegMetadata.version} · configuration=${ffmpegMetadata.configuration} · sha256=${ffmpegMetadata.sha256}`);
console.log(`ffprobe: ${ffprobeMetadata.version} · configuration=${ffprobeMetadata.configuration} · sha256=${ffprobeMetadata.sha256}`);
console.log(`media tools: source=${manifest.tools.source} · license=${manifest.tools.license_classification} · redistributable=true`);
console.log(`codesign gate: ${process.env.MIRRORORDER_REQUIRE_CODESIGN === "1" ? "required and passed" : "not required for this local build"}`);
console.log("Final Cut import, real-media playback, multicam sync and LAN second-device smoke remain explicit native gates.");
