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
assert(!mainSource.includes("golden-material-script-theme.css"), "retired Golden Material/Script theme must not return to the global stylesheet graph");

const sourceTsxFiles = listFiles("src", new Set([".tsx"]));
const sourceCssFiles = listFiles("src", new Set([".css"]));

const projectWorkbench = read("src/features/production/ProjectWorkbench.tsx");
const materialWorkspace = read("src/features/material/MaterialWorkspace.tsx");
const materialTakeView = read("src/features/material/MaterialTakeView.tsx");
const materialWorkspaceCss = read("src/features/material/material-workspace.css");
const scriptWorkspace = read("src/features/script/ScriptWorkspace.tsx");
const reviewWorkspace = read("src/features/review/ReviewWorkspace.tsx");
const resumeState = read("src/app/resumeState.ts");

assert(projectWorkbench.includes('review: {\n    label: "审阅",\n    defaultPage: "watch",\n    pages: [\n      { page: "watch", label: "看片" },\n    ],'), "Review must remain one production surface; attention/overview are not standalone pages");
assert(!projectWorkbench.includes("ReviewAttentionWorkbench"), "Attention must not return as a standalone production workbench");
assert(!projectWorkbench.includes("ProjectOverviewWorkbench"), "Project overview must not return as a standalone review workbench");
assert(projectWorkbench.includes('{ page: "media-binding", label: "本机素材", hidden: true }'), "Media binding must stay a hidden repair tool, not a primary production page");
assert(projectWorkbench.includes('const showSecondaryNavigation = area !== "material"'), "Material subviews must be owned inside MaterialWorkspace instead of ProjectWorkbench secondary navigation");
assert(resumeState.includes('if (page === "attention" || page === "overview") return "watch";'), "Legacy attention/overview resume routes must collapse into Review");

assert(projectWorkbench.includes('type ProductionArea = "material" | "script" | "timeline" | "review"'), "Desktop production areas must remain Material / Script / Timeline / Review");
assert(projectWorkbench.includes("<MaterialWorkspace"), "ProjectWorkbench must route Material to MaterialWorkspace");
assert(projectWorkbench.includes("<ScriptWorkspace"), "ProjectWorkbench must route Script to ScriptWorkspace");
assert(projectWorkbench.includes("<ReviewWorkspace"), "ProjectWorkbench must route Review to ReviewWorkspace");
assert(!projectWorkbench.includes("MaterialScriptWorkbench"), "cross-domain MaterialScriptWorkbench must not return");
for (const surface of ["takes", "script", "review"]) {
  assert(!projectWorkbench.includes(`surface="${surface}"`), `production routing must not reintroduce surface="${surface}" mode switching`);
}

assert(materialWorkspace.includes('export type MaterialView = "slate" | "library" | "takes" | "people" | "repair"'), "MaterialWorkspace must own the Material domain views");
assert(materialWorkspace.includes('aria-label="素材视图"'), "MaterialWorkspace must expose one internal view switcher");
for (const child of ["GoldenSlateWorkbench", "MediaLibraryWorkbench", "MaterialTakeView", "IdentityWorkbench", "MediaBindingWorkbench"]) {
  assert(materialWorkspace.includes(child), `MaterialWorkspace must compose ${child}`);
}
for (const directImport of ["IdentityWorkbench", "MediaLibraryWorkbench", "MediaBindingWorkbench", "GoldenSlateWorkbench"]) {
  assert(!projectWorkbench.includes(`import { ${directImport} }`), `ProjectWorkbench must not directly own Material child view ${directImport}`);
}
assert(materialWorkspace.includes('onOpenMediaBinding={() => onViewChange("repair")}'), "media repair must remain a contextual Material tool");
assert(materialWorkspace.includes('onClick={() => onViewChange("library")}'), "Material repair must return to the library context");
assert(!materialWorkspace.includes("setGroupPlacement"), "Material must not own Review placement writes");
assert(!materialWorkspace.includes("clearGroupPlacement"), "Material must not clear Review placement");
assert(!materialWorkspace.includes("showEditorial"), "Material must not own Final Editorial Decision controls");

assert(materialTakeView.includes("production.scriptSupervisor(project.project_id)"), "Material Take view must project Script Supervisor facts");
assert(materialTakeView.includes("slateFactIndex"), "Material Take view must join Slate facts to Take identity without exposing raw ids");
assert(materialTakeView.includes("mediaAvailabilityLabel"), "Material Take view must make media availability visible");
assert(materialTakeView.includes("mappingLabel(take)"), "Material Take view must show current Script mapping as read-only context");
assert(materialTakeView.includes(">在剧本中打开</button>"), "Material Take must deep-link to Script");
assert(materialTakeView.includes(">在审阅中打开</button>"), "Material Take must deep-link to Review");
assert(materialTakeView.includes(">到时间线</button>"), "Material Take must deep-link to Timeline");
assert(materialTakeView.includes(">修复本机素材</button>"), "offline Material Take must expose contextual media repair");
assert(!materialTakeView.includes("setGroupPlacement"), "Material Take view must not write Review placement");
assert(!materialTakeView.includes("clearGroupPlacement"), "Material Take view must not clear Review placement");
assert(!materialTakeView.includes("showEditorial"), "Material Take view must not render Editorial Decision controls");
for (const selector of [".mo-take-list-row", ".mo-take-list-core", ".mo-take-list-heading", ".mo-take-list-cameras"]) {
  assert(!materialWorkspaceCss.includes(selector), `material-workspace.css must not reclaim canonical compact Take anatomy through ${selector}`);
}

assert(scriptWorkspace.includes("connection.setGroupPlacement"), "Script must own Review placement writes");
assert(scriptWorkspace.includes("connection.clearGroupPlacement"), "Script must own placement correction/clear");
assert(scriptWorkspace.includes("RoughPlacementClient"), "batch placement must stay inside Script authority");
assert(reviewWorkspace.includes("showEditorial"), "Review must own Editorial Decision controls");
assert(reviewWorkspace.includes('{ value: "attention", label: "需关注" }'), "Attention must remain a Review filter");
assert(!reviewWorkspace.includes("setGroupPlacement"), "Review must not duplicate Script placement editing");
assert(!reviewWorkspace.includes("clearGroupPlacement"), "Review must not clear Script placement directly");
assert(projectWorkbench.includes('onOpenScript={(groupId) => focusTake(groupId, "script")}'), "Material Take must preserve identity when opening Script");
assert(projectWorkbench.includes('groupId ? focusTake(groupId, "watch") : navigate("watch")'), "Material Take must preserve identity when opening Review");
assert(projectWorkbench.includes('onOpenTimeline={(groupId) => focusTake(groupId, "timeline")}'), "Material Take must preserve identity intent when opening Timeline");
assert(projectWorkbench.includes('onOpenTake={(groupId) => focusTake(groupId, "script")}'), "Coverage evidence must return to Script");
assert(!projectWorkbench.includes("ReviewReturnContext"), "cross-workspace return state must not become a second navigation system");

for (const retiredPath of [
  "src/features/material-script/MaterialScriptWorkbench.tsx",
  "src/features/material-script/material-script-workbench.css",
  "src/features/material-script/GoldenMaterialScriptWorkbench.tsx",
  "src/features/material-script/golden-material-script.css",
  "src/features/material-script/golden-material-script-theme.css",
]) {
  assert(!fs.existsSync(path.join(desktopRoot, retiredPath)), `${retiredPath} is retired and must not return`);
}

const forbiddenContextTakeSelectors = [
  ".golden-take-picker-list > button",
  ".golden-take-picker-list strong",
  ".golden-take-picker-list span",
  ".golden-take-picker-list small",
  ".golden-episode-candidates > button",
];
for (const relativePath of sourceCssFiles) {
  const source = read(relativePath);
  for (const selector of forbiddenContextTakeSelectors) {
    assert(!source.includes(selector), `${relativePath} must not style canonical compact Take anatomy through ${selector}`);
  }
}

const canonicalRenderers = [
  ["MirrorOrderMediaCard", "src/features/media/MirrorOrderMediaCard.tsx"],
  ["TakeCard", "src/features/material-script/TakeCard.tsx"],
  ["TakeListRow", "src/features/material-script/TakeCard.tsx"],
  ["ScriptBlock", "src/features/material-script/ScriptBlock.tsx"],
  ["IdentityCandidateRow", "src/features/identity/IdentityRows.tsx"],
  ["PersonRow", "src/features/identity/IdentityRows.tsx"],
  ["SlateRow", "src/features/slate/SlateRow.tsx"],
  ["SlateTableHead", "src/features/slate/SlateRow.tsx"],
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
assert(takeCard.includes('import "./take-card.css"'), "canonical Take renderers must own their compact stylesheet import");
assert(takeCard.includes('data-ui-authority="take-compact"'), "TakeListRow must expose the canonical compact Take authority marker");
assert(!takeCard.includes("className?: string;"), "TakeListRow must not expose arbitrary className styling escape hatches");
const compactTakeStyleOwners = sourceCssFiles.filter((relativePath) => read(relativePath).includes(".mo-take-list-"));
assert(
  compactTakeStyleOwners.length === 1 && compactTakeStyleOwners[0] === "src/features/material-script/take-card.css",
  `compact Take styling must have one owner; found ${compactTakeStyleOwners.length ? compactTakeStyleOwners.join(", ") : "none"}`,
);

const virtualTakeList = read("src/features/material-script/VirtualTakeList.tsx");
assert(!/\bfunction\s+TakeCard\b/.test(virtualTakeList), "VirtualTakeList must not hide a second TakeCard implementation");
assert(!virtualTakeList.includes("const STABLE_CAMERA_SLOTS"), "VirtualTakeList must not redefine stable camera slots");
assert(virtualTakeList.includes('from "./TakeCard"'), "VirtualTakeList must consume the canonical TakeCard");
assert(virtualTakeList.includes("TakeListRow"), "compact Material/Review lists must consume the canonical TakeListRow");
assert(virtualTakeList.includes("detailForTake"), "VirtualTakeList may project workspace detail without duplicating Take anatomy");

const slatePlacementPools = read("src/features/slate/SlatePlacementPools.tsx");
assert(slatePlacementPools.includes("TakeListRow"), "SlatePlacementPools must consume the canonical compact Take renderer");
assert(!/\bfunction\s+TakeCard\b/.test(slatePlacementPools), "SlatePlacementPools must not reintroduce a second TakeCard implementation");
assert(!slatePlacementPools.includes("golden-placement-take"), "SlatePlacementPools must not style Take rows through a local card class");

const slateRow = read("src/features/slate/SlateRow.tsx");
assert(slateRow.includes("export const SLATE_CAMERA_COLUMNS"), "SlateRow must own the fixed A/B/C/AUX camera column contract");
assert(slateRow.includes("export const SLATE_COLUMN_KEYS"), "SlateRow must own the fixed ledger column order");
const goldenSlate = read("src/features/slate/GoldenSlateWorkbench.tsx");
assert(goldenSlate.includes('from "./SlateRow"'), "GoldenSlateWorkbench must consume the canonical SlateRow renderer");
assert(!goldenSlate.includes("<td className=\"col-"), "GoldenSlateWorkbench must not own SlateRow table cells");
assert(!goldenSlate.includes("<th className=\"col-"), "GoldenSlateWorkbench must not own Slate column headers");
assert(!goldenSlate.includes("SlateStatusIndicator"), "Slate status placement must remain inside the canonical SlateRow");
assert(goldenSlate.includes('from "../material-script/TakeCard"'), "GoldenSlateWorkbench must consume the canonical compact Take renderer");
assert((goldenSlate.match(/<TakeListRow\b/g) ?? []).length >= 2, "Slate Take picker and episode candidates must both use TakeListRow");
assert(!goldenSlate.includes("golden-take-angle"), "GoldenSlateWorkbench must not hand-render camera chips for Take candidates");
assert(!goldenSlate.includes("cameraPresentation("), "GoldenSlateWorkbench must not rebuild compact Take camera presentation locally");
const goldenSlateCss = read("src/features/slate/golden-slate.css");
assert(!goldenSlateCss.includes(".golden-take-picker-list > button"), "Golden Slate CSS must not reclaim compact Take row anatomy in the picker");
assert(!goldenSlateCss.includes(".golden-take-picker-list strong"), "Golden Slate CSS must not style canonical Take descendants through broad picker selectors");
assert(!goldenSlateCss.includes(".golden-episode-candidates > button"), "Golden Slate CSS must not reclaim compact Take row anatomy in episode candidates");

const scriptBlock = read("src/features/material-script/ScriptBlock.tsx");
assert(scriptBlock.includes("export function ScriptBlock"), "ScriptBlock must remain an independently importable canonical renderer");
assert(!scriptBlock.includes("<code>{block.segment_id}</code>"), "primary Script UI must not expose raw segment ids");
const scriptEpisode = read("src/features/material-script/ScriptEpisodeView.tsx");
assert(scriptEpisode.includes('from "./ScriptBlock"'), "ScriptEpisodeView must consume the canonical ScriptBlock");
assert(!scriptEpisode.includes('className={`script-block'), "ScriptEpisodeView must not hide a second ScriptBlock anatomy");
assert(!scriptEpisode.includes("{scene.scene_id}</p>"), "primary Script UI must not expose raw scene ids");

const identityRows = read("src/features/identity/IdentityRows.tsx");
assert(identityRows.includes("export function IdentityCandidateRow"), "IdentityCandidateRow must remain independently importable");
assert(identityRows.includes("export function PersonRow"), "PersonRow must remain independently importable");
assert(identityRows.includes('import "./identity-rows.css"'), "canonical Identity rows must own their stylesheet import");
assert(identityRows.includes('data-ui-authority="identity-row"'), "Identity rows must expose the canonical row authority marker");
assert(identityRows.includes('data-authority="candidate"'), "identity candidates must expose evidence/candidate authority");
assert(identityRows.includes('data-authority="human"'), "confirmed people must expose human authority");
const identityWorkbench = read("src/features/identity/IdentityWorkbench.tsx");
assert(identityWorkbench.includes('from "./IdentityRows"'), "IdentityWorkbench must consume canonical identity rows");
assert(!identityWorkbench.includes('className={`identity-row'), "IdentityWorkbench must not hide another identity row renderer");
const identityWorkbenchCss = read("src/features/identity/identity-workbench.css");
for (const selector of [".identity-row {", ".identity-row-copy", ".identity-row-meta", ".identity-portrait"]) {
  assert(!identityWorkbenchCss.includes(selector), `identity-workbench.css must not own canonical Identity anatomy through ${selector}`);
}
const workspaceRedesignCss = read("src/app/mirrororder-workspaces-redesign.css");
for (const selector of [".identity-row {", ".identity-workbench .identity-row", ".identity-row-copy", ".identity-row-meta", ".identity-avatar"]) {
  assert(!workspaceRedesignCss.includes(selector), `mirrororder-workspaces-redesign.css must not reclaim canonical Identity anatomy through ${selector}`);
}
const identityAnatomyOwners = sourceCssFiles.filter((relativePath) => {
  const source = read(relativePath);
  return source.includes(".identity-row-copy") || source.includes(".identity-row-meta") || source.includes(".identity-portrait");
});
assert(
  identityAnatomyOwners.length === 1 && identityAnatomyOwners[0] === "src/features/identity/identity-rows.css",
  `Identity row/portrait anatomy must have one stylesheet owner; found ${identityAnatomyOwners.length ? identityAnatomyOwners.join(", ") : "none"}`,
);

const angleEvidence = read("src/features/material-script/AngleEvidenceCard.tsx");
assert(angleEvidence.includes("MirrorOrderMediaCard"), "AngleEvidenceCard must remain a data adapter over the canonical MediaCard renderer");

if (!process.exitCode) {
  console.log(
    `UI authority OK: ${cssImports.length} allowlisted global stylesheet layers; ` +
    `${canonicalRenderers.length} canonical renderer owners unique; workspace authority and migration/Golden layer budgets did not grow.`,
  );
}
