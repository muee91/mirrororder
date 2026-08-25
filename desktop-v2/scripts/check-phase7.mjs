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
assert(parity.branch === "main", "Phase 7 cutover contract must target main");
assert(parity.desktop_primary_candidate === true, "Desktop v2 must remain the primary desktop implementation");
assert(parity.swiftui_retirement_allowed === true, "SwiftUI retirement should stay recorded as completed by owner cutover");
assert(parity.retirement_policy?.swiftui_state === "removed_by_owner_cutover", "SwiftUI state must record the owner-directed cutover");
assert(parity.retirement_policy?.owner_cutover_override === true, "owner cutover override must remain explicit");
assert(!fs.existsSync(path.join(repoRoot, "macos-app")), "legacy macos-app directory must not return after cutover");

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

assert(parity.retirement_policy?.release_gates_still_required_for_desktop_quality === true, "native release gates must remain quality gates after SwiftUI removal");
assert(parity.isolation_policy?.production_project_tabs_are_parity_surfaces === true, "production project tabs must remain parity/product surfaces");
assert(parity.isolation_policy?.team_web_is_top_level_workspace === true, "Team Web must remain a top-level isolated workspace");
assert(parity.isolation_policy?.heavy_capabilities_require_isolated_module_or_worktree === true, "heavy capabilities must remain isolated before promotion");

const runtimePackaging = parity.isolated_workstreams?.runtime_packaging;
assert(runtimePackaging?.branch === "feat/desktop-v2-runtime-packaging", "runtime packaging must point to the isolated workstream branch");
assert(runtimePackaging?.status === "isolated_blocker", "runtime packaging must stay an explicit blocker until it is actually solved");
assert(parity.release_gates?.packaged_python_runtime === "required", "packaged Python runtime must stay a release gate");
assert(parity.release_gates?.packaged_media_toolchain === "required", "packaged ffmpeg/ffprobe toolchain must stay a release gate");
assert(runtimePackaging?.blocks?.includes("packaged_python_runtime"), "runtime packaging must block packaged Python release readiness");
assert(runtimePackaging?.blocks?.includes("packaged_media_toolchain"), "runtime packaging must block packaged media-tool release readiness");

if (!process.exitCode) {
  console.log(`Phase 7 contract OK: ${Object.keys(parity.gates).length} parity gates, ${Object.keys(parity.release_gates).length} release gates.`);
  console.log("Desktop v2 is the sole desktop implementation; native release gates remain required for distributable quality.");
}
