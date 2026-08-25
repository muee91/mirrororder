import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const resourcesRoot = path.join(desktopRoot, "src-tauri", "resources");
const coreTarget = path.join(resourcesRoot, "mirrororder-core");
const pythonTarget = path.join(resourcesRoot, "mirrororder-python");
const toolsTarget = path.join(resourcesRoot, "mirrororder-tools");
const manifestTarget = path.join(resourcesRoot, "mirrororder-runtime-manifest.json");

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

function executableCandidates(root, names) {
  return names.map((name) => path.join(root, name));
}

function firstFile(candidates, label) {
  const found = candidates.find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
  if (!found) fail(`${label} not found; tried ${candidates.join(", ")}`);
  return found;
}

function run(executable, args, label) {
  const result = spawnSync(executable, args, { encoding: "utf8", windowsHide: true });
  if (result.error) fail(`${label}: ${result.error.message}`);
  if (result.status !== 0) {
    fail(`${label} exited ${result.status}: ${(result.stderr || result.stdout || "").trim()}`);
  }
  return (result.stdout || "").trim();
}

function cleanTarget(target) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(target)) {
    if (entry === ".gitkeep") continue;
    fs.rmSync(path.join(target, entry), { recursive: true, force: true });
  }
}

function copyDirectory(source, target) {
  fs.cpSync(source, target, {
    recursive: true,
    force: true,
    dereference: false,
    preserveTimestamps: true,
  });
}

const portablePythonRoot = requireDirectory(
  process.env.MIRRORORDER_PORTABLE_PYTHON_ROOT,
  "MIRRORORDER_PORTABLE_PYTHON_ROOT",
);
const mediaToolsRoot = requireDirectory(
  process.env.MIRRORORDER_MEDIA_TOOLS_ROOT,
  "MIRRORORDER_MEDIA_TOOLS_ROOT",
);

const windows = process.platform === "win32";
const pythonExecutable = firstFile(
  windows
    ? executableCandidates(portablePythonRoot, ["python.exe", path.join("bin", "python.exe")])
    : executableCandidates(portablePythonRoot, [path.join("bin", "python3"), path.join("bin", "python")]),
  "portable Python executable",
);
const toolBin = path.join(mediaToolsRoot, "bin");
const ffmpegName = windows ? "ffmpeg.exe" : "ffmpeg";
const ffprobeName = windows ? "ffprobe.exe" : "ffprobe";
const ffmpegExecutable = firstFile([path.join(toolBin, ffmpegName)], "ffmpeg");
const ffprobeExecutable = firstFile([path.join(toolBin, ffprobeName)], "ffprobe");

const pythonProbe = run(
  pythonExecutable,
  [
    "-c",
    [
      "import json, sys",
      "assert sys.version_info >= (3, 11), sys.version",
      "import numpy, pandas, scipy",
      "print(json.dumps({'version': sys.version.split()[0], 'modules': ['numpy','pandas','scipy']}))",
    ].join("; "),
  ],
  "portable Python prerequisite probe",
);
let pythonInfo;
try {
  pythonInfo = JSON.parse(pythonProbe.split(/\r?\n/).at(-1));
} catch {
  fail(`portable Python prerequisite probe returned invalid JSON: ${pythonProbe}`);
}
const ffmpegVersion = run(ffmpegExecutable, ["-version"], "ffmpeg probe").split(/\r?\n/)[0] || "ffmpeg";
const ffprobeVersion = run(ffprobeExecutable, ["-version"], "ffprobe probe").split(/\r?\n/)[0] || "ffprobe";

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

fs.mkdirSync(resourcesRoot, { recursive: true });
cleanTarget(coreTarget);
cleanTarget(pythonTarget);
cleanTarget(toolsTarget);

copyDirectory(organizerSource, path.join(coreTarget, "src", "script_organizer"));
copyDirectory(multicamSource, path.join(coreTarget, "vendor", "multicam-audio-sync"));
fs.copyFileSync(pyprojectSource, path.join(coreTarget, "pyproject.toml"));
copyDirectory(portablePythonRoot, pythonTarget);
copyDirectory(mediaToolsRoot, toolsTarget);

for (const executable of [
  windows ? path.join(pythonTarget, "python.exe") : path.join(pythonTarget, "bin", "python3"),
  path.join(toolsTarget, "bin", ffmpegName),
  path.join(toolsTarget, "bin", ffprobeName),
]) {
  if (fs.existsSync(executable) && !windows) fs.chmodSync(executable, 0o755);
}

const manifest = {
  contract: "mirrororder_packaged_runtime.v1",
  staged_at: new Date().toISOString(),
  core: {
    python_package: "src/script_organizer",
    multicam_engine: "vendor/multicam-audio-sync",
  },
  python: {
    version: pythonInfo.version,
    required_modules: pythonInfo.modules,
    source: "MIRRORORDER_PORTABLE_PYTHON_ROOT",
  },
  tools: {
    ffmpeg: ffmpegVersion,
    ffprobe: ffprobeVersion,
    source: "MIRRORORDER_MEDIA_TOOLS_ROOT",
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

console.log(`Packaged runtime staged: Python ${manifest.python.version}`);
console.log(`Core: ${coreTarget}`);
console.log(`Python: ${pythonTarget}`);
console.log(`Tools: ${toolsTarget}`);
