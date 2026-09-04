import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");

function fail(message) {
  console.error(`UI authority check failed: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function read(relativePath) {
  const fullPath = path.join(desktopRoot, relativePath);
  assert(fs.existsSync(fullPath), `${relativePath} is missing`);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
}

const allowedGlobalCssImports = new Set([
  "./styles.css",
  "./desktop-theme.css",
  "./desktop-theme-tools.css",
  "./features/material-script/golden-material-script-theme.css",
  "./desktop-theme-slate.css",
  "./desktop-theme-frozen-surfaces.css",
  "./features/media/media-binding-recovery.css",
  "./app/mirrororder-redesign.css",
  "./app/mirrororder-workspaces-redesign.css",
  "./app/project-context-redesign.css",
  "./app/app-chrome.css",
  "./design-system-v2.css",
]);

const mainSource = read("src/main.tsx");
const cssImports = [...mainSource.matchAll(/^import\s+["'](.+?\.css)["'];?$/gm)].map((match) => match[1]);
for (const cssImport of cssImports) {
  assert(
    allowedGlobalCssImports.has(cssImport),
    `new global stylesheet layer ${cssImport} is not allowed; migrate an existing owner instead of stacking another layer`,
  );
}
assert(cssImports.includes("./design-system-v2.css"), "Design System v2 must remain loaded by the Desktop entry point");

const cameraPresentation = read("src/features/media/cameraPresentation.ts");
assert(cameraPresentation.includes("export const STABLE_CAMERA_SLOTS"), "cameraPresentation.ts must own the stable A/B/C/AUX slot definition");

const takeCard = read("src/features/material-script/TakeCard.tsx");
assert(takeCard.includes("export function TakeCard"), "TakeCard must remain an independently importable canonical renderer");
assert(takeCard.includes("STABLE_CAMERA_SLOTS"), "TakeCard must consume the shared camera slot definition");

const virtualTakeList = read("src/features/material-script/VirtualTakeList.tsx");
assert(!/\bfunction\s+TakeCard\b/.test(virtualTakeList), "VirtualTakeList must not hide a second TakeCard implementation");
assert(!virtualTakeList.includes("const STABLE_CAMERA_SLOTS"), "VirtualTakeList must not redefine stable camera slots");
assert(virtualTakeList.includes('from "./TakeCard"'), "VirtualTakeList must consume the canonical TakeCard");

const scriptBlock = read("src/features/material-script/ScriptBlock.tsx");
assert(scriptBlock.includes("export function ScriptBlock"), "ScriptBlock must remain an independently importable canonical renderer");
const scriptEpisode = read("src/features/material-script/ScriptEpisodeView.tsx");
assert(scriptEpisode.includes('from "./ScriptBlock"'), "ScriptEpisodeView must consume the canonical ScriptBlock");
assert(!scriptEpisode.includes('className={`script-block'), "ScriptEpisodeView must not hide a second ScriptBlock anatomy");

const angleEvidence = read("src/features/material-script/AngleEvidenceCard.tsx");
assert(angleEvidence.includes("MirrorOrderMediaCard"), "AngleEvidenceCard must remain a data adapter over the canonical MediaCard renderer");

if (!process.exitCode) {
  console.log(`UI authority OK: ${cssImports.length} allowlisted global stylesheet layers; canonical MediaCard/TakeCard/ScriptBlock contracts intact.`);
}
