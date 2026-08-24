import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const desktopRoot = path.resolve(here, "..");
const repoRoot = path.resolve(desktopRoot, "..");
const parityPath = path.join(desktopRoot, "phase7-parity.json");

function fail(message) {
  console.error(`Phase 7 check failed: ${message}`);
  process.exitCode = 1;
}

function assert(condition, message) {
  if (!condition) fail(message);
}

const parity = JSON.parse(fs.readFileSync(parityPath, "utf8"));

assert(parity.contract === "desktop_phase7_parity.v1", `unexpected contract ${String(parity.contract)}`);
assert(parity.desktop_primary_candidate === true, "Desktop must remain marked as the primary candidate");
assert(parity.swiftui_retirement_allowed === false, "SwiftUI deletion must remain blocked until release gates are actually verified");
assert(parity.retirement_policy?.new_features_allowed_in_swiftui === false, "SwiftUI must stay feature-frozen");
assert(parity.retirement_policy?.physical_delete_before_release_gates === false, "SwiftUI physical deletion cannot precede release gates");

for (const [name, gate] of Object.entries(parity.gates ?? {})) {
  assert(String(gate.code_status ?? "").startsWith("implemented"), `${name} is not code-complete: ${String(gate.code_status)}`);
  assert(Array.isArray(gate.evidence) && gate.evidence.length > 0, `${name} has no evidence paths`);
  for (const evidence of gate.evidence ?? []) {
    const absolute = path.join(repoRoot, evidence);
    assert(fs.existsSync(absolute), `${name} evidence is missing: ${evidence}`);
  }
}

for (const [name, value] of Object.entries(parity.release_gates ?? {})) {
  assert(value === "required", `release gate ${name} must remain required until verified`);
}

assert(parity.isolation_policy?.production_project_tabs_are_parity_surfaces === true, "production project tabs must remain parity/product surfaces");
assert(parity.isolation_policy?.team_web_is_top_level_workspace === true, "Team Web must remain a top-level isolated workspace");
assert(parity.isolation_policy?.heavy_capabilities_require_isolated_module_or_worktree === true, "heavy capabilities must remain isolated before promotion");

const runtimePackaging = parity.isolated_workstreams?.runtime_packaging;
assert(runtimePackaging?.branch === "feat/desktop-v2-runtime-packaging", "runtime packaging must point to the isolated workstream branch");
assert(runtimePackaging?.status === "isolated_blocker", "runtime packaging must stay an explicit blocker until it is actually solved");
assert(parity.release_gates?.packaged_python_runtime === "required", "packaged Python runtime must stay a release gate");

if (!process.exitCode) {
  console.log(`Phase 7 contract OK: ${Object.keys(parity.gates).length} parity gates, ${Object.keys(parity.release_gates).length} release gates.`);
  console.log("SwiftUI retirement remains blocked; heavy runtime packaging remains isolated.");
}
