import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildToolMetadata, parseToolVersionOutput } from "./runtime-tools.mjs";

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

function parseJsonProbe(output, label) {
  try {
    return JSON.parse(output.split(/\r?\n/).at(-1));
  } catch {
    fail(`${label} returned invalid JSON: ${output}`);
  }
}

function probeSemanticRuntime(pythonExecutable, label) {
  const output = run(
    pythonExecutable,
    [
      "-I",
      "-c",
      [
        "import importlib, json",
        "required = {'sentence_transformers': 'sentence_transformers', 'transformers': 'transformers', 'torch': 'torch', 'torchvision': 'torchvision', 'PIL': 'PIL'}",
        "modules = {}",
        "errors = {}",
        "for key, module_name in required.items():",
        "    try:",
        "        module = importlib.import_module(module_name)",
        "        modules[key] = str(getattr(module, '__version__', 'unknown'))",
        "    except Exception as error:",
        "        errors[key] = str(error)[:500]",
        "print(json.dumps({'available': not errors, 'modules': modules, 'errors': errors}, sort_keys=True))",
      ].join("\n"),
    ],
    label,
  );
  const info = parseJsonProbe(output, label);
  if (process.env.MIRRORORDER_REQUIRE_SEMANTIC_RUNTIME === "1" && info.available !== true) {
    fail(`${label} missing required semantic modules: ${JSON.stringify(info.errors)}`);
  }
  return info;
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

function isMachOCandidate(item, stat) {
  const extensionCandidate = /\.(?:dylib|so)(?:\..*)?$/i.test(path.basename(item));
  const executableStat = stat.isSymbolicLink() ? fs.statSync(item) : stat;
  return extensionCandidate || Boolean(executableStat.mode & 0o111);
}

function collectMachOFiles(root) {
  const files = [];
  const visited = new Set();
  const visit = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const item = path.join(current, entry.name);
      const stat = fs.lstatSync(item);
      if (stat.isDirectory()) {
        visit(item);
        continue;
      }
      if (!stat.isFile() && !stat.isSymbolicLink()) continue;
      if (stat.isSymbolicLink() && !fs.statSync(item).isFile()) continue;
      if (!isMachOCandidate(item, stat)) continue;
      const realPath = fs.realpathSync(item);
      if (visited.has(realPath)) continue;
      visited.add(realPath);
      if (run("file", ["-b", realPath], `Mach-O probe ${path.basename(item)}`).includes("Mach-O")) {
        files.push(realPath);
      }
    }
  };
  visit(root);
  return files.sort();
}

function isAllowedMachODependency(dependency) {
  return (
    dependency.startsWith("@rpath/") ||
    dependency.startsWith("@loader_path/") ||
    dependency.startsWith("@executable_path/") ||
    dependency.startsWith("/usr/lib/") ||
    dependency.startsWith("/System/Library/")
  );
}

function localMachODependency(binary, dependency, byBasename) {
  const basename = path.basename(dependency);
  const sameDirectory = path.join(path.dirname(binary), basename);
  if (fs.existsSync(sameDirectory) && fs.statSync(sameDirectory).isFile()) return fs.realpathSync(sameDirectory);
  const suffix = dependency.split("/").slice(-3).join("/");
  const suffixMatches = (byBasename.get(basename) || []).filter((candidate) => candidate.endsWith(`/${suffix}`));
  if (suffixMatches.length === 1) return suffixMatches[0];
  const matches = byBasename.get(basename) || [];
  return matches.length === 1 ? matches[0] : null;
}

function loaderRelativePath(binary, target) {
  const relative = path.relative(path.dirname(binary), target).split(path.sep).join("/");
  return `@loader_path/${relative}`;
}

function normalizeBundledMachOPaths(root) {
  if (process.platform !== "darwin") return;
  const binaries = collectMachOFiles(root);
  const byBasename = new Map();
  for (const binary of binaries) {
    const basename = path.basename(binary);
    const entries = byBasename.get(basename) || [];
    entries.push(binary);
    byBasename.set(basename, entries);
  }
  let rewrites = 0;
  for (const binary of binaries) {
    const output = run("otool", ["-L", binary], `Mach-O dependency probe ${path.basename(binary)}`);
    let modified = false;
    for (const raw of output.split(/\r?\n/).slice(1)) {
      if (!/^\s/.test(raw)) continue; // universal-binary architecture headers are not dependencies
      const dependency = raw.trim().split(" (compatibility")[0];
      if (!dependency || isAllowedMachODependency(dependency) || dependency === path.basename(binary)) continue;
      const target = localMachODependency(binary, dependency, byBasename);
      if (!target) fail(`staged Mach-O dependency is not bundled: ${binary} -> ${dependency}`);
      const replacement = loaderRelativePath(binary, target);
      run("install_name_tool", ["-change", dependency, replacement, binary], `rewrite ${path.basename(binary)} dependency`);
      modified = true;
      rewrites += 1;
    }
    if (/\.(?:dylib|so)(?:\..*)?$/i.test(path.basename(binary))) {
      const idOutput = spawnSync("otool", ["-D", binary], { encoding: "utf8" });
      const installName = idOutput.status === 0 ? (idOutput.stdout || "").trim().split(/\r?\n/)[1] : "";
      if (installName && !isAllowedMachODependency(installName) && installName !== path.basename(binary)) {
        run("install_name_tool", ["-id", `@loader_path/${path.basename(binary)}`, binary], `rewrite ${path.basename(binary)} install name`);
        modified = true;
        rewrites += 1;
      }
    }
    if (modified) {
      // install_name_tool invalidates wheel signatures. macOS may refuse to
      // load the modified nested library (notably Torch's libomp) unless the
      // staged copy is signed again before the isolated import probe.
      run("codesign", ["--force", "--sign", "-", binary], `re-sign ${path.basename(binary)}`);
    }
  }
  console.log(`Mach-O relocation: ${binaries.length} files inspected · ${rewrites} install names normalized`);
}

function cleanGeneratedTarget(target) {
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
const semanticRequirementsPath = path.join(repoRoot, "requirements-semantic.txt");
if (!fs.existsSync(semanticRequirementsPath)) fail(`semantic requirements missing: ${semanticRequirementsPath}`);
const semanticRequirementsSha256 = crypto
  .createHash("sha256")
  .update(fs.readFileSync(semanticRequirementsPath))
  .digest("hex");
const semanticProfilesSource = fs.readFileSync(path.join(repoRoot, "src", "script_organizer", "semantic_profiles.py"), "utf8");
const semanticModel = "Qwen/Qwen3-VL-Embedding-2B";
if (!semanticProfilesSource.includes(`model="${semanticModel}"`)) {
  fail(`semantic profile model is not pinned to ${semanticModel}`);
}
const semanticModelRevision = semanticProfilesSource.match(/STANDARD_MODEL_REVISION\s*=\s*"([0-9a-f]{40})"/)?.[1];
if (!semanticModelRevision) fail("standard semantic profile has no 40-character pinned model revision");

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
  ["-I", "-c", `import sys; sys.path.insert(0, ${sourcePathLiteral}); import script_organizer.cli; print('mirrororder-core-import-ok')`],
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

const stagedPython = path.join(pythonTarget, pythonRelativeExecutable);
const stagedFfmpeg = path.join(toolsTarget, "bin", "ffmpeg");
const stagedFfprobe = path.join(toolsTarget, "bin", "ffprobe");
for (const executable of [stagedPython, stagedFfmpeg, stagedFfprobe]) {
  if (fs.existsSync(executable)) fs.chmodSync(executable, 0o755);
}

assertSelfContainedSymlinks(pythonTarget, "staged portable Python runtime");
assertSelfContainedSymlinks(toolsTarget, "staged media tools runtime");
normalizeBundledMachOPaths(pythonTarget);
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
const stagedSemanticInfo = probeSemanticRuntime(stagedPython, "staged Python semantic runtime probe");
const stagedCorePathLiteral = JSON.stringify(path.join(coreTarget, "src"));
run(
  stagedPython,
  ["-I", "-c", `import sys; sys.path.insert(0, ${stagedCorePathLiteral}); import script_organizer.cli; print('staged-core-import-ok')`],
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
  semantic: {
    profile: "standard",
    runtime: "sentence-transformers",
    model: semanticModel,
    revision: semanticModelRevision,
    included: stagedSemanticInfo.available === true,
    runtime_available: stagedSemanticInfo.available === true,
    modules: stagedSemanticInfo.modules,
    import_errors: stagedSemanticInfo.errors,
    requirements: "requirements-semantic.txt",
    requirements_sha256: semanticRequirementsSha256,
    provenance: "MIRRORORDER_PORTABLE_PYTHON_ROOT",
    model_weights: "not bundled",
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
console.log(`Semantic runtime: ${manifest.semantic.included ? "included" : "unavailable"} · model=${manifest.semantic.model}@${manifest.semantic.revision} · modules=${JSON.stringify(manifest.semantic.modules)} · requirements_sha256=${manifest.semantic.requirements_sha256}`);
