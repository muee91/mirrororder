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
assertSelfContainedSymlinks(portablePythonRoot, "portable Python runtime");
assertSelfContainedSymlinks(mediaToolsRoot, "media tools runtime");

const windows = process.platform === "win32";
const pythonExecutable = firstFile(
  windows
    ? executableCandidates(portablePythonRoot, ["python.exe", path.join("bin", "python.exe")])
    : executableCandidates(portablePythonRoot, [path.join("bin", "python3"), path.join("bin", "python")]),
  "portable Python executable",
);
const pythonRelativeExecutable = path.relative(portablePythonRoot, pythonExecutable);
const toolBin = path.join(mediaToolsRoot, "bin");
const ffmpegName = windows ? "ffmpeg.exe" : "ffmpeg";
const ffprobeName = windows ? "ffprobe.exe" : "ffprobe";
const ffmpegExecutable = firstFile([path.join(toolBin, ffmpegName)], "ffmpeg");
const ffprobeExecutable = firstFile([path.join(toolBin, ffprobeName)], "ffprobe");

const pythonProbe = run(
  pythonExecutable,
  [
    "-I",
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

const sourcePathLiteral = JSON.stringify(path.join(repoRoot, "src"));
run(
  pythonExecutable,
  [
    "-I",
    "-c",
    `import sys; sys.path.insert(0, ${sourcePathLiteral}); import script_organizer.cli; print('mirrororder-core-import-ok')`,
  ],
  "MirrorOrder Core import probe",
);

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

const requiredMulticamFiles = [
  "project_config.py",
  "make_index.py",
  "extract_parallel.py",
  "sync.py",
  "compress_gaps.py",
  "build_fcpxml.py",
  "build_capcut_fcpxml.py",
  "build_capcut_draft_31.py",
  "build_pr_xml.py",
  "validate_fcpxml.py",
  "validate_capcut_draft.py",
  "capcut_draft_schema.json",
];
for (const name of requiredMulticamFiles) {
  const candidate = path.join(multicamSource, "scripts", name);
  if (!fs.existsSync(candidate)) fail(`first-party multicam engine missing scripts/${name}`);
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

const stagedPython = path.join(pythonTarget, pythonRelativeExecutable);
const stagedFfmpeg = path.join(toolsTarget, "bin", ffmpegName);
const stagedFfprobe = path.join(toolsTarget, "bin", ffprobeName);
for (const executable of [stagedPython, stagedFfmpeg, stagedFfprobe]) {
  if (fs.existsSync(executable) && !windows) fs.chmodSync(executable, 0o755);
}

assertSelfContainedSymlinks(pythonTarget, "staged portable Python runtime");
assertSelfContainedSymlinks(toolsTarget, "staged media tools runtime");
const stagedPythonProbe = run(
  stagedPython,
  [
    "-I",
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
  [
    "-I",
    "-c",
    `import sys; sys.path.insert(0, ${stagedCorePathLiteral}); import script_organizer.cli; print('staged-core-import-ok')`,
  ],
  "staged MirrorOrder Core import probe",
  {
    env: {
      ...process.env,
      PATH: `${path.dirname(stagedFfmpeg)}${path.delimiter}${process.env.PATH || ""}`,
      MIRRORORDER_MULTICAM_SYNC_ROOT: path.join(coreTarget, "vendor", "multicam-audio-sync"),
    },
  },
);
run(stagedFfmpeg, ["-version"], "staged ffmpeg relocation probe");
run(stagedFfprobe, ["-version"], "staged ffprobe relocation probe");

const manifest = {
  contract: "mirrororder_packaged_runtime.v1",
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
    ffmpeg: ffmpegVersion,
    ffprobe: ffprobeVersion,
    relocation_probe: true,
    source: "MIRRORORDER_MEDIA_TOOLS_ROOT",
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

console.log(`Packaged runtime staged: Python ${manifest.python.version}`);
console.log(`Core: ${coreTarget}`);
console.log(`Python: ${pythonTarget}`);
console.log(`Tools: ${toolsTarget}`);
