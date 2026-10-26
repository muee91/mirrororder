import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildToolMetadata, isBundleJunkPath, parseToolVersionOutput } from "./runtime-tools.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const coreTarget = path.join(resourcesRoot, "mirrororder-core");
const pythonTarget = path.join(resourcesRoot, "mirrororder-python");
const toolsTarget = path.join(resourcesRoot, "mirrororder-tools");
const manifestDir = path.join(resourcesRoot, "mirrororder-runtime");
const manifestTarget = path.join(manifestDir, "mirrororder-runtime-manifest.json");

function fail(message) {
  console.error(`Runtime staging failed: ${message}`);
  process.exit(1);
}

function requireDirectory(value, name) {
  if (!value?.trim()) fail(`${name} is required`);
  const resolved = path.resolve(value);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    fail(`${name} is not a directory: ${resolved}`);
  }
  return resolved;
}

function firstFile(candidates, label) {
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) fail(`${label} not found; tried ${candidates.join(", ")}`);
  return found;
}

function run(executable, args, label, options = {}) {
  const result = spawnSync(executable, args, {
    encoding: "utf8",
    windowsHide: true,
    ...options,
  });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout || "").trim();
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

function assertSelfContainedSymlinks(root, label) {
  const realRoot = fs.realpathSync(root);
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      const stat = fs.lstatSync(item);
      if (stat.isSymbolicLink()) {
        let target;
        try {
          target = fs.realpathSync(item);
        } catch (error) {
          fail(`${label} contains a broken symlink: ${item} (${error.message})`);
        }
        if (!isInside(realRoot, target)) {
          fail(`${label} symlink escapes runtime root: ${item} -> ${target}`);
        }
        continue;
      }
      if (stat.isDirectory()) visit(item);
    }
  };
  visit(root);
}

function cleanGeneratedTarget(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target)) {
    if (entry === ".gitkeep") continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}

// Per-machine or generated files must never reach a distributable bundle. The sync engine
// reads scripts/config.json through MIRRORORDER_MULTICAM_CONFIG and falls back to built-in
// defaults when it is absent, so a staged copy only leaks the build machine's volume paths
// and project names. AppleDouble `._*` files additionally break CapCut draft parsing on
// external volumes, and byte-code caches inside a sealed (possibly read-only) bundle are a
// runtime failure waiting to happen. Rule lives in runtime-tools.mjs so the stager and the
// bundle gate cannot drift apart.
function* walkDirectoryFiles(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walkDirectoryFiles(full);
    else if (entry.isFile()) yield full;
  }
}

function copyDirectory(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
    filter: (candidate) => !isBundleJunkPath(candidate),
  });
}

if (process.platform !== "darwin" && process.env.MIRRORORDER_ALLOW_NON_MAC_RUNTIME_STAGE !== "1") {
  fail("this stabilization path is macOS-first; set MIRRORORDER_ALLOW_NON_MAC_RUNTIME_STAGE=1 only for explicit cross-platform work");
}

const portablePythonRoot = requireDirectory(
  process.env.MIRRORORDER_PORTABLE_PYTHON_ROOT,
  "MIRRORORDER_PORTABLE_PYTHON_ROOT",
);
const mediaToolsRoot = requireDirectory(
  process.env.MIRRORORDER_MEDIA_TOOLS_ROOT,
  "MIRRORORDER_MEDIA_TOOLS_ROOT",
);
assertSelfContainedSymlinks(portablePythonRoot, "portable Python runtime");
assertSelfContainedSymlinks(mediaToolsRoot, "media tools runtime");

const pythonExecutable = firstFile(
  [path.join(portablePythonRoot, "bin", "python3"), path.join(portablePythonRoot, "bin", "python")],
  "portable Python executable",
);
const pythonRelativeExecutable = path.relative(portablePythonRoot, pythonExecutable);
const toolBin = path.join(mediaToolsRoot, "bin");
const ffmpegExecutable = firstFile([path.join(toolBin, "ffmpeg")], "ffmpeg");
const ffprobeExecutable = firstFile([path.join(toolBin, "ffprobe")], "ffprobe");
const mediaToolsSource = process.env.MIRRORORDER_MEDIA_TOOLS_SOURCE?.trim();
const mediaToolsLicense = process.env.MIRRORORDER_MEDIA_TOOLS_LICENSE?.trim();
if (!mediaToolsSource) fail("MIRRORORDER_MEDIA_TOOLS_SOURCE is required; media tool provenance cannot be implicit");
if (!mediaToolsLicense) fail("MIRRORORDER_MEDIA_TOOLS_LICENSE is required; media tool license classification cannot be implicit");

try {
  parseToolVersionOutput("ffmpeg", run(ffmpegExecutable, ["-version"], "ffmpeg source policy probe"));
  parseToolVersionOutput("ffprobe", run(ffprobeExecutable, ["-version"], "ffprobe source policy probe"));
} catch (error) {
  fail(`media tool redistribution policy: ${error.message}`);
}

const pythonProbe = run(
  pythonExecutable,
  [
    "-I",
    // -B on every python invocation against trees that ship in the bundle:
    // imports otherwise write __pycache__ into the packaged runtime.
    "-B",
    "-c",
    [
      "import json, sys",
      "assert sys.version_info >= (3, 11), sys.version",
      "import numpy, pandas, scipy",
      "print(json.dumps({'version': sys.version.split()[0], 'modules': ['numpy','pandas','scipy'], 'executable': sys.executable, 'prefix': sys.prefix}))",
    ].join("; "),
  ],
  "portable Python isolated prerequisite probe",
);
let pythonInfo;
try {
  pythonInfo = JSON.parse(pythonProbe.split(/\r?\n/).at(-1));
} catch {
  fail(`portable Python prerequisite probe returned invalid JSON: ${pythonProbe}`);
}
for (const [label, candidate] of [["sys.executable", pythonInfo.executable], ["sys.prefix", pythonInfo.prefix]]) {
  if (!candidate || !fs.existsSync(candidate)) fail(`portable Python ${label} does not exist: ${String(candidate)}`);
  if (!isInside(fs.realpathSync(portablePythonRoot), fs.realpathSync(candidate))) {
    fail(`portable Python ${label} escapes MIRRORORDER_PORTABLE_PYTHON_ROOT: ${candidate}`);
  }
}

const organizerSource = path.join(repoRoot, "src", "script_organizer");
const multicamSource = path.join(repoRoot, "vendor", "multicam-audio-sync");
const pyprojectSource = path.join(repoRoot, "pyproject.toml");
for (const [source, label] of [
  [organizerSource, "src/script_organizer"],
  [multicamSource, "vendor/multicam-audio-sync"],
  [pyprojectSource, "pyproject.toml"],
]) {
  if (!fs.existsSync(source)) fail(`repository source missing: ${label}`);
}

const sourcePathLiteral = JSON.stringify(path.join(repoRoot, "src"));
run(
  pythonExecutable,
  // -B: this probe imports the REPO source tree; without it Python writes
  // __pycache__ into src/, which is exactly what staging must not copy.
  ["-I", "-B", "-c", `import sys; sys.path.insert(0, ${sourcePathLiteral}); import script_organizer.cli; print('mirrororder-core-import-ok')`],
  "MirrorOrder Core import probe",
);

const ffmpegVersion = run(ffmpegExecutable, ["-version"], "ffmpeg probe").split(/\r?\n/)[0] || "ffmpeg";
const ffprobeVersion = run(ffprobeExecutable, ["-version"], "ffprobe probe").split(/\r?\n/)[0] || "ffprobe";

fs.mkdirSync(resourcesRoot, { recursive: true });
for (const target of [coreTarget, pythonTarget, toolsTarget, manifestDir]) cleanGeneratedTarget(target);

copyDirectory(organizerSource, path.join(coreTarget, "src", "script_organizer"));
copyDirectory(multicamSource, path.join(coreTarget, "vendor", "multicam-audio-sync"));
fs.copyFileSync(pyprojectSource, path.join(coreTarget, "pyproject.toml"));
copyDirectory(portablePythonRoot, pythonTarget);
copyDirectory(mediaToolsRoot, toolsTarget);
// Upstream Homebrew dylibs ship read-only (444); the Tauri build script and
// codesigning rewrite these files, so staged copies must be writable.
for (const file of walkDirectoryFiles(toolsTarget)) fs.chmodSync(file, 0o644);

const stagedPython = path.join(pythonTarget, pythonRelativeExecutable);
const stagedFfmpeg = path.join(toolsTarget, "bin", "ffmpeg");
const stagedFfprobe = path.join(toolsTarget, "bin", "ffprobe");
for (const executable of [stagedPython, stagedFfmpeg, stagedFfprobe]) {
  if (fs.existsSync(executable)) fs.chmodSync(executable, 0o755);
}

assertSelfContainedSymlinks(pythonTarget, "staged portable Python runtime");
assertSelfContainedSymlinks(toolsTarget, "staged media tools runtime");
const stagedPythonProbe = run(
  stagedPython,
  [
    "-I",
    "-B",
    "-c",
    [
      "import json, sys",
      "assert sys.version_info >= (3, 11), sys.version",
      "import numpy, pandas, scipy",
      "print(json.dumps({'version': sys.version.split()[0], 'executable': sys.executable, 'prefix': sys.prefix}))",
    ].join("; "),
  ],
  "staged Python relocation probe",
);
let stagedPythonInfo;
try {
  stagedPythonInfo = JSON.parse(stagedPythonProbe.split(/\r?\n/).at(-1));
} catch {
  fail(`staged Python relocation probe returned invalid JSON: ${stagedPythonProbe}`);
}
for (const [label, candidate] of [["sys.executable", stagedPythonInfo.executable], ["sys.prefix", stagedPythonInfo.prefix]]) {
  if (!candidate || !fs.existsSync(candidate)) fail(`staged Python ${label} does not exist: ${String(candidate)}`);
  if (!isInside(fs.realpathSync(pythonTarget), fs.realpathSync(candidate))) {
    fail(`staged Python ${label} escapes staged runtime: ${candidate}`);
  }
}
const stagedCorePathLiteral = JSON.stringify(path.join(coreTarget, "src"));
run(
  stagedPython,
  // -B keeps the probe from writing __pycache__ into the staged tree it is
  // validating - the bundle must not ship build-machine bytecode.
  ["-I", "-B", "-c", `import sys; sys.path.insert(0, ${stagedCorePathLiteral}); import script_organizer.cli; print('staged-core-import-ok')`],
  "staged MirrorOrder Core import probe",
  {
    env: {
      ...process.env,
      PATH: `${path.dirname(stagedFfmpeg)}${path.delimiter}${process.env.PATH || ""}`,
      MIRRORORDER_MULTICAM_SYNC_ROOT: path.join(coreTarget, "vendor", "multicam-audio-sync"),
    },
  },
);
const stagedFfmpegVersionOutput = run(stagedFfmpeg, ["-version"], "staged ffmpeg relocation probe");
const stagedFfprobeVersionOutput = run(stagedFfprobe, ["-version"], "staged ffprobe relocation probe");
let ffmpegMetadata;
let ffprobeMetadata;
try {
  ffmpegMetadata = buildToolMetadata({
    toolName: "ffmpeg",
    output: stagedFfmpegVersionOutput,
    filePath: stagedFfmpeg,
    source: mediaToolsSource,
    licenseClassification: mediaToolsLicense,
  });
  ffprobeMetadata = buildToolMetadata({
    toolName: "ffprobe",
    output: stagedFfprobeVersionOutput,
    filePath: stagedFfprobe,
    source: mediaToolsSource,
    licenseClassification: mediaToolsLicense,
  });
} catch (error) {
  fail(`staged media tool redistribution policy: ${error.message}`);
}

const manifest = {
  contract: "mirrororder_packaged_runtime.v1",
  platform: process.platform,
  arch: process.arch,
  staged_at: new Date().toISOString(),
  core: {
    python_package: "src/script_organizer",
    multicam_engine: "vendor/multicam-audio-sync",
  },
  python: {
    version: stagedPythonInfo.version,
    executable: pythonRelativeExecutable,
    required_modules: pythonInfo.modules,
    isolated_probe: true,
    relocation_probe: true,
    source: "MIRRORORDER_PORTABLE_PYTHON_ROOT",
  },
  tools: {
    ffmpeg: ffmpegMetadata,
    ffprobe: ffprobeMetadata,
    source: mediaToolsSource,
    provenance: mediaToolsSource,
    license: mediaToolsLicense,
    license_classification: mediaToolsLicense,
    redistributable: true,
    relocation_probe: true,
    input_root: "MIRRORORDER_MEDIA_TOOLS_ROOT",
  },
  safety: {
    external_symlinks_allowed: false,
    system_python_fallback_in_packaged_mode: false,
    system_ffmpeg_fallback_in_packaged_mode: false,
  },
  optional_not_bundled_by_this_gate: [
    "llama-server",
    "faster_whisper",
    "mlx_whisper",
    "cv2",
    "sherpa_onnx",
    "model weights",
  ],
};
fs.writeFileSync(manifestTarget, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`Packaged runtime staged: Python ${manifest.python.version} · ${manifest.platform}/${manifest.arch}`);
console.log(`Core: ${coreTarget}`);
console.log(`Python: ${pythonTarget}`);
console.log(`Tools: ${toolsTarget}`);
console.log(`Manifest: ${manifestTarget}`);
