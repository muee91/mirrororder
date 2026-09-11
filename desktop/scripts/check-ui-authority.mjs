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
const productionNavigation = read("src/features/production/productionNavigation.ts");
const materialWorkspace = read("src/features/material/MaterialWorkspace.tsx");
const materialTakeView = read("src/features/material/MaterialTakeView.tsx");
const materialWorkspaceCss = read("src/features/material/material-workspace.css");
const scriptWorkspace = read("src/features/script/ScriptWorkspace.tsx");
const scriptWorkspaceCss = read("src/features/script/script-workspace.css");
const reviewWorkspace = read("src/features/review/ReviewWorkspace.tsx");
const reviewDecision = read("src/features/review/ReviewDecisionPanel.tsx");
const takeInspector = read("src/features/material-script/TakeInspector.tsx");
const timelineWorkspace = read("src/features/editor/TimelineWorkbench.tsx");
const resumeState = read("src/app/resumeState.ts");

assert(productionNavigation.includes('export type ProductionWorkspace = "material" | "script" | "timeline" | "review"'), "Desktop production areas must remain Material / Script / Timeline / Review");
assert(productionNavigation.includes("export interface ProductionSelectionContext"), "cross-workspace selection must have one typed navigation context");
assert(productionNavigation.includes("export interface ProductionNavigationIntent extends ProductionSelectionContext"), "navigation intent must extend selection context instead of becoming business truth");
assert(projectWorkbench.includes("const [selection, setSelection] = useState<ProductionSelectionContext>"), "ProjectWorkbench must own only typed selection/navigation intent");
assert(!projectWorkbench.includes("ReviewReturnContext"), "cross-workspace return state must not become a second navigation system");
assert(!projectWorkbench.includes("reviewReturn"), "legacy Review return orchestration must not return");

for (const [key, label] of [["material", "素材"], ["script", "剧本"], ["timeline", "时间线"], ["review", "审阅"]]) {
  assert(projectWorkbench.includes(`${key}: {\n    label: "${label}"`), `ProjectWorkbench must keep ${label} as a top-level workspace`);
}
assert(projectWorkbench.includes("<MaterialWorkspace"), "ProjectWorkbench must route Material to MaterialWorkspace");
assert(projectWorkbench.includes("<ScriptWorkspace"), "ProjectWorkbench must route Script to ScriptWorkspace");
assert(projectWorkbench.includes("<TimelineWorkbench"), "ProjectWorkbench must route Timeline to TimelineWorkbench");
assert(projectWorkbench.includes("<ReviewWorkspace"), "ProjectWorkbench must route Review to ReviewWorkspace");
assert(!projectWorkbench.includes("MaterialScriptWorkbench"), "cross-domain MaterialScriptWorkbench must not return");
assert(!projectWorkbench.includes("professional-secondary-nav"), "top-level workspaces must not regain peer sub-app navigation");
assert(!projectWorkbench.includes('{ page: "coverage", label: "覆盖"'), "Coverage must be a Script projection, not a page definition");
assert(!projectWorkbench.includes('{ page: "delivery", label: "交付"'), "Delivery must be a Timeline flow, not a page definition");
assert(resumeState.includes('if (page === "coverage") return "script";'), "legacy Coverage resume routes must collapse into Script");
assert(resumeState.includes('if (page === "rough-cut" || page === "assembly" || page === "delivery") return "timeline";'), "legacy editor/delivery routes must collapse into Timeline");
assert(resumeState.includes('if (page === "attention" || page === "overview") return "watch";'), "legacy attention/overview resume routes must collapse into Review");

assert(materialWorkspace.includes('export type MaterialView = "slate" | "library" | "takes" | "people" | "repair"'), "MaterialWorkspace must own Material domain views");
assert(materialWorkspace.includes('aria-label="素材视图"'), "MaterialWorkspace must expose one internal view switcher");
for (const child of ["GoldenSlateWorkbench", "MediaLibraryWorkbench", "MaterialTakeView", "IdentityWorkbench", "MediaBindingWorkbench"]) {
  assert(materialWorkspace.includes(child), `MaterialWorkspace must compose ${child}`);
}
for (const directImport of ["IdentityWorkbench", "MediaLibraryWorkbench", "MediaBindingWorkbench", "GoldenSlateWorkbench"]) {
  assert(!projectWorkbench.includes(`import { ${directImport} }`), `ProjectWorkbench must not directly own Material child view ${directImport}`);
}
assert(materialWorkspace.includes('onOpenMediaBinding={() => onViewChange("repair")}'), "media repair must remain a contextual Material tool");
assert(materialWorkspace.includes('onClick={() => onViewChange("library")}'), "Material repair must return to the library context");

// Review placement/exclusion writes have exactly one home (Script) plus one
// sanctioned auxiliary surface (golden-slate-placement-pools, 具名豁免见
// INVARIANTS Product workflow boundaries)。扫描整个 features/app 树：任何
// 新组件进入某个 workspace 合成树都不能悄悄 reintroduce 第二个归集控制器。
const placementWriteAllowlist = new Set([
  "src/features/script/ScriptWorkspace.tsx", // Script owns placement correction/clear
  "src/features/slate/SlatePlacementPools.tsx", // sanctioned golden-slate auxiliary surface
]);
for (const file of listFiles("src", new Set([".ts", ".tsx"]))) {
  if (file.startsWith("src/api/") || file.includes(".test.")) continue;
  const text = read(file);
  for (const token of ["setGroupPlacement", "clearGroupPlacement", "setGroupExclusion"]) {
    if (!text.includes(token)) continue;
    assert(
      placementWriteAllowlist.has(file),
      `${file} must not own Review placement/exclusion writes (${token}); the only sanctioned surfaces are Script and the golden-slate placement pools exemption`,
    );
  }
}

assert(materialTakeView.includes("production.scriptSupervisor(project.project_id)"), "Material Take view must project Script Supervisor facts");
assert(materialTakeView.includes("slateFactIndex"), "Material Take view must join Slate facts to Take identity without exposing raw ids");
assert(materialTakeView.includes("mediaAvailabilityLabel"), "Material Take view must make media availability visible");
assert(materialTakeView.includes("mappingLabel(take)"), "Material Take view must show current Script mapping as read-only context");
assert(materialTakeView.includes(">在剧本中打开</button>"), "Material Take must deep-link to Script");
assert(materialTakeView.includes(">在审阅中打开</button>"), "Material Take must deep-link to Review");
assert(materialTakeView.includes(">到时间线</button>"), "Material Take must deep-link to Timeline");
assert(materialTakeView.includes(">修复本机素材</button>"), "offline Material Take must expose contextual media repair");
assert(materialTakeView.includes("onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId)"), "Material Take selection must propagate through typed project context");
for (const selector of [".mo-take-list-row", ".mo-take-list-core", ".mo-take-list-heading", ".mo-take-list-cameras"]) {
  assert(!materialWorkspaceCss.includes(selector), `material-workspace.css must not reclaim canonical compact Take anatomy through ${selector}`);
}

assert(scriptWorkspace.includes("ScriptProjectionMode"), "Script must expose explicit in-workspace projection modes");
assert(scriptWorkspace.includes('{ value: "script", label: "正文" }'), "Script must keep the normal reading projection");
assert(scriptWorkspace.includes('{ value: "coverage", label: "覆盖" }'), "Coverage must live inside Script as a projection");
assert(scriptWorkspace.includes('{ value: "issues", label: "问题" }'), "Script must expose an issue-focused projection");
assert(scriptWorkspace.includes('placeholder="搜索剧本、角色或场景"'), "Script must support direct script search");
assert(scriptWorkspace.includes("placeTakeOnSelectedBlock"), "Script segment context must support direct Take placement");
assert(scriptWorkspace.includes("actionForTake=") && scriptWorkspace.includes('"归集到此段"'), "Script candidates must act on the selected ScriptBlock instead of a generic material tray");
assert(scriptWorkspace.includes("connection.setGroupPlacement"), "Script must own Review placement writes");
assert(scriptWorkspace.includes("connection.clearGroupPlacement"), "Script must own placement correction/clear");
assert(scriptWorkspace.includes("RoughPlacementClient"), "batch episode-only placement must stay inside Script authority");
assert(scriptWorkspace.includes("onSelectionChange?.(selectedTake?.group_id ?? null, selectedClipId, selectedScriptSegmentId)"), "Script selection must propagate through typed project context");
for (const label of ["在素材中打开", "在审阅中打开", "到时间线"]) {
  assert(scriptWorkspace.includes(`>${label}</button>`), `Script Take context must expose ${label}`);
}
for (const selector of [".script-block {", ".script-block-meta {", ".script-block p {", ".script-block-actions button {"]) {
  assert(!scriptWorkspaceCss.includes(selector), `script-workspace.css must not reclaim canonical ScriptBlock anatomy through ${selector}`);
}

assert(reviewWorkspace.includes("<ReviewDecisionPanel"), "ReviewWorkspace must own Take-level Final Editorial Decision workflow");
assert(reviewWorkspace.includes('{ value: "unreviewed", label: "未决定" }'), "Review queue must prioritize undecided Takes");
assert(reviewWorkspace.includes('{ value: "attention", label: "需关注" }'), "Attention must remain a Review filter");
assert(reviewDecision.includes('targetKind: "group"'), "Review Final Editorial Decision must target the current Take group");
assert(!reviewDecision.includes('decide("assignment"'), "Review must not become a Script assignment decision editor");
assert(!reviewWorkspace.includes("setGroupPlacement"), "Review must not duplicate Script placement editing");
assert(!reviewWorkspace.includes("clearGroupPlacement"), "Review must not clear Script placement directly");
assert(!takeInspector.includes("showEditorial"), "canonical TakeInspector must not contain Review workflow mode switches");
assert(!takeInspector.includes("EditorialDecisionPanel"), "canonical TakeInspector must not own Final Editorial Decision workflow");
assert(takeInspector.includes("afterPlayback?: ReactNode"), "TakeInspector may expose composition slots without owning workspace workflow");

assert(timelineWorkspace.includes("useTimelineAuthorityActions"), "Timeline must remain the authoritative local editor");
assert(timelineWorkspace.includes("<DeliveryWorkbench"), "Delivery must be composed as a Timeline follow-up flow");
assert(timelineWorkspace.includes('aria-label="时间线交付"'), "Timeline must own the Delivery contextual surface");
assert(timelineWorkspace.includes("onSelectionChange?.(groupId, clipId, timelineClipId)"), "Timeline selection must propagate through typed project context");

for (const retiredPath of [
  "src/features/material-script/MaterialScriptWorkbench.tsx",
  "src/features/material-script/material-script-workbench.css",
  "src/features/material-script/GoldenMaterialScriptWorkbench.tsx",
  "src/features/material-script/golden-material-script.css",
  "src/features/material-script/golden-material-script-theme.css",
  "src/features/material-script/TakeEvidencePanels.tsx",
  "src/features/material-script/editorial-inspector.css",
  "src/features/planning/PlanningWorkbenches.tsx",
  "src/features/planning/planning.css",
  "src/features/production/secondary-tools-theme.css",
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
assert(scriptBlock.includes('data-script-projection={projectionMode}'), "ScriptBlock must expose projection state without duplicating renderers");
assert(scriptBlock.includes("mappedTakeIds"), "ScriptBlock must present mapped Take state");
assert(scriptBlock.includes("candidateTakeIds"), "ScriptBlock must present candidate Take state");
assert(!scriptBlock.includes("<code>{block.segment_id}</code>"), "primary Script UI must not expose raw segment ids");
const scriptEpisode = read("src/features/material-script/ScriptEpisodeView.tsx");
assert(scriptEpisode.includes('from "./ScriptBlock"'), "ScriptEpisodeView must consume the canonical ScriptBlock");
assert(scriptEpisode.includes("mappedTakeIds(model, block.segment_id)"), "ScriptEpisodeView must project mapped Take state into canonical ScriptBlock");
assert(scriptEpisode.includes("candidateTakeIds(model, block.segment_id)"), "ScriptEpisodeView must project candidate Take state into canonical ScriptBlock");
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
    `${canonicalRenderers.length} canonical renderer owners unique; four workspace authorities and migration/Golden layer budgets did not grow.`,
  );
}
