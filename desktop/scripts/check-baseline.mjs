import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const baselinePath = path.join(desktopRoot, "development-baseline.json");

function fail(message) {
  console.error(`Development baseline check failed: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));

assert(baseline.contract === "desktop_development_baseline.v1", `unexpected contract ${String(baseline.contract)}`);
assert(baseline.branch === "main", "development baseline must target main");
assert(baseline.state === "active_development_baseline", "baseline state must remain active_development_baseline");
assert(baseline.desktop_path === "desktop", "desktop path must remain desktop/");
assert(fs.existsSync(path.join(repoRoot, "desktop")), "desktop/ is missing");
assert(!fs.existsSync(path.join(repoRoot, "desktop-v2")), "desktop-v2/ must not return to the baseline");
assert(!fs.existsSync(path.join(repoRoot, "macos-app")), "removed legacy desktop client must not return");

for (const [name, capability] of Object.entries(baseline.capabilities ?? {})) {
  assert(capability.code_status === "implemented", `${name} is not marked implemented`);
}

for (const [name, value] of Object.entries(baseline.release_gates ?? {})) {
  assert(value === "required", `release gate ${name} must remain required until actually verified`);
}

assert(baseline.isolation_policy?.production_project_tabs_are_product_surfaces === true, "project tabs must remain product surfaces");
assert(baseline.isolation_policy?.team_web_is_top_level_workspace === true, "Team Web must remain a top-level workspace");
assert(baseline.isolation_policy?.heavy_capabilities_require_isolated_module_or_worktree === true, "heavy capabilities must remain isolated before promotion");
for (const [name, workstream] of Object.entries(baseline.active_workstreams ?? {})) {
  assert(typeof workstream?.branch === "string" && workstream.branch.length > 0, `active workstream ${name} must declare a branch`);
  assert(typeof workstream?.status === "string" && workstream.status.length > 0, `active workstream ${name} must declare a status`);
}

if (!process.exitCode) {
  console.log(`Development baseline OK: ${Object.keys(baseline.capabilities).length} capabilities, ${Object.keys(baseline.release_gates).length} release gates.`);
}
