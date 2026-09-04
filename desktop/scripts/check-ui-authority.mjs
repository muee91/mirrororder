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

function normalize(relativePath) {
  return relativePath.split(path.sep).join("/");
}

function read(relativePath) {
  const fullPath = path.join(desktopRoot, relativePath);
  assert(fs.existsSync(fullPath), `${relativePath} is missing`);
  return fs.existsSync(fullPath) ? fs.readFileSync(fullPath, "utf8") : "";
}

function listFiles(relativeDir, extensions) {
  const root = path.join(desktopRoot, relativeDir);
  const files = [];
  function visit(current) {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        visit(fullPath);
        continue;
      }
      if (!extensions.has(path.extname(entry.name))) continue;
      files.push(normalize(path.relative(desktopRoot, fullPath)));
    }
  }
  visit(root);
  return files.sort();
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function componentDefinitionPattern(symbol) {
  const name = escapeRegex(symbol);
  return new RegExp(
    `\\b(?:export\\s+(?:default\\s+)?)?(?:async\\s+)?function\\s+${name}\\b|` +
    `\\b(?:export\\s+(?:default\\s+)?)?class\\s+${name}\\b|` +
    `\\b(?:export\\s+)?const\\s+${name}\\s*=`,
  );
}

function assertCanonicalDefinition(symbol, ownerPath, sourceFiles) {
  const pattern = componentDefinitionPattern(symbol);
  const matches = sourceFiles.filter((relativePath) => pattern.test(read(relativePath)));
  assert(
    matches.length === 1 && matches[0] === ownerPath,
    `${symbol} implementation ownership drifted; expected only ${ownerPath}, found ${matches.length ? matches.join(", ") : "none"}`,
  );
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

const sourceTsxFiles = listFiles("src", new Set([".tsx"]));
const sourceCssFiles = listFiles("src", new Set([".css"]));

const canonicalRenderers = [
  ["MirrorOrderMediaCard", "src/features/media/MirrorOrderMediaCard.tsx"],
  ["TakeCard", "src/features/material-script/TakeCard.tsx"],
  ["TakeListRow", "src/features/material-script/TakeCard.tsx"],
  ["ScriptBlock", "src/features/material-script/ScriptBlock.tsx"],
  ["IdentityCandidateRow", "src/features/identity/IdentityRows.tsx"],
  ["PersonRow", "src/features/identity/IdentityRows.tsx"],
];
for (const [symbol, ownerPath] of canonicalRenderers) {
  assertCanonicalDefinition(symbol, ownerPath, sourceTsxFiles);
}

const grandfatheredMigrationStyles = new Set([
  "src/desktop-theme-frozen-surfaces.css",
  "src/features/media/media-binding-recovery.css",
  "src/app/mirrororder-redesign.css",
  "src/app/mirrororder-workspaces-redesign.css",
  "src/app/project-context-redesign.css",
  "src/features/projects/project-library-fidelity.css",
  "src/features/media/media-health-adoption.css",
]);
const migrationStylePattern = /(?:redesign|frozen|recovery|fidelity|adoption)(?:[-_.]|$)/i;
for (const relativePath of sourceCssFiles) {
  if (!migrationStylePattern.test(path.basename(relativePath))) continue;
  assert(
    grandfatheredMigrationStyles.has(relativePath),
    `new migration-era stylesheet ${relativePath} is not allowed; shrink or replace an existing owner instead`,
  );
}

const grandfatheredGoldenStyles = new Set([
  "src/features/material-script/golden-material-script-theme.css",
  "src/features/material-script/golden-material-script.css",
  "src/features/slate/golden-slate-media-experience.css",
  "src/features/slate/golden-slate.css",
]);
for (const relativePath of sourceCssFiles) {
  if (!path.basename(relativePath).startsWith("golden-")) continue;
  assert(
    grandfatheredGoldenStyles.has(relativePath),
    `new Golden migration stylesheet ${relativePath} is not allowed; finish migration in an existing owner`,
  );
}

const grandfatheredGoldenComponents = new Set([
  "src/features/material-script/GoldenMaterialScriptWorkbench.tsx",
  "src/features/slate/GoldenSlateWorkbench.tsx",
]);
for (const relativePath of sourceTsxFiles) {
  if (!path.basename(relativePath).startsWith("Golden")) continue;
  assert(
    grandfatheredGoldenComponents.has(relativePath),
    `new Golden migration component ${relativePath} is not allowed; extract a canonical component instead`,
  );
}

const cameraPresentation = read("src/features/media/cameraPresentation.ts");
assert(cameraPresentation.includes("export const STABLE_CAMERA_SLOTS"), "cameraPresentation.ts must own the stable A/B/C/AUX slot definition");

const takeCard = read("src/features/material-script/TakeCard.tsx");
assert(takeCard.includes("export function TakeCard"), "TakeCard must remain an independently importable canonical renderer");
assert(takeCard.includes("export function TakeListRow"), "TakeListRow must remain owned beside the canonical TakeCard");
assert(takeCard.includes("STABLE_CAMERA_SLOTS"), "TakeCard must consume the shared camera slot definition");

const virtualTakeList = read("src/features/material-script/VirtualTakeList.tsx");
assert(!/\bfunction\s+TakeCard\b/.test(virtualTakeList), "VirtualTakeList must not hide a second TakeCard implementation");
assert(!virtualTakeList.includes("const STABLE_CAMERA_SLOTS"), "VirtualTakeList must not redefine stable camera slots");
assert(virtualTakeList.includes('from "./TakeCard"'), "VirtualTakeList must consume the canonical TakeCard");

const slatePlacementPools = read("src/features/slate/SlatePlacementPools.tsx");
assert(slatePlacementPools.includes("TakeListRow"), "SlatePlacementPools must consume the canonical compact Take renderer");
assert(!/\bfunction\s+TakeCard\b/.test(slatePlacementPools), "SlatePlacementPools must not reintroduce a second TakeCard implementation");

const scriptBlock = read("src/features/material-script/ScriptBlock.tsx");
assert(scriptBlock.includes("export function ScriptBlock"), "ScriptBlock must remain an independently importable canonical renderer");
const scriptEpisode = read("src/features/material-script/ScriptEpisodeView.tsx");
assert(scriptEpisode.includes('from "./ScriptBlock"'), "ScriptEpisodeView must consume the canonical ScriptBlock");
assert(!scriptEpisode.includes('className={`script-block'), "ScriptEpisodeView must not hide a second ScriptBlock anatomy");

const identityRows = read("src/features/identity/IdentityRows.tsx");
assert(identityRows.includes("export function IdentityCandidateRow"), "IdentityCandidateRow must remain independently importable");
assert(identityRows.includes("export function PersonRow"), "PersonRow must remain independently importable");
assert(identityRows.includes('data-authority="candidate"'), "identity candidates must expose evidence/candidate authority");
assert(identityRows.includes('data-authority="human"'), "confirmed people must expose human authority");
const identityWorkbench = read("src/features/identity/IdentityWorkbench.tsx");
assert(identityWorkbench.includes('from "./IdentityRows"'), "IdentityWorkbench must consume canonical identity rows");
assert(!identityWorkbench.includes('className={`identity-row'), "IdentityWorkbench must not hide another identity row renderer");

const angleEvidence = read("src/features/material-script/AngleEvidenceCard.tsx");
assert(angleEvidence.includes("MirrorOrderMediaCard"), "AngleEvidenceCard must remain a data adapter over the canonical MediaCard renderer");

if (!process.exitCode) {
  console.log(
    `UI authority OK: ${cssImports.length} allowlisted global stylesheet layers; ` +
    `${canonicalRenderers.length} canonical renderer owners unique; migration/Golden layer budgets did not grow.`,
  );
}
