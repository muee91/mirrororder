import { describe, expect, it } from "vitest";
import parity from "../../phase7-parity.json";

describe("Phase 7 parity gate", () => {
  it("keeps all required desktop parity surfaces code-complete", () => {
    const required = [
      "project_lifecycle",
      "material_script",
      "slate",
      "identity",
      "assistant",
      "settings_status",
      "media_binding",
      "team_web_gateway",
      "macos_fcp_integration",
    ] as const;

    for (const gate of required) {
      expect(parity.gates[gate].code_status).toMatch(/^implemented/);
      expect(parity.gates[gate].evidence.length).toBeGreaterThan(0);
    }
    expect(parity.branch).toBe("main");
    expect(parity.desktop_primary_candidate).toBe(true);
  });

  it("keeps heavy capabilities out of the project-tab dumping ground", () => {
    expect(parity.isolation_policy.production_project_tabs_are_parity_surfaces).toBe(true);
    expect(parity.isolation_policy.team_web_is_top_level_workspace).toBe(true);
    expect(parity.isolation_policy.heavy_capabilities_require_isolated_module_or_worktree).toBe(true);
    expect(parity.isolated_workstreams.runtime_packaging.branch).toBe("feat/desktop-v2-runtime-packaging");
    expect(parity.isolated_workstreams.runtime_packaging.status).toBe("isolated_blocker");
    expect(parity.isolated_workstreams.runtime_packaging.blocks).toContain("packaged_python_runtime");
    expect(parity.isolated_workstreams.runtime_packaging.blocks).toContain("packaged_media_toolchain");
  });

  it("records the owner-directed SwiftUI cutover without weakening release quality gates", () => {
    expect(parity.swiftui_retirement_allowed).toBe(true);
    expect(parity.retirement_policy.swiftui_state).toBe("removed_by_owner_cutover");
    expect(parity.retirement_policy.owner_cutover_override).toBe(true);
    expect(parity.retirement_policy.release_gates_still_required_for_desktop_quality).toBe(true);

    const requiredNativeGates = [
      "packaged_python_runtime",
      "packaged_media_toolchain",
      "macos_tauri_build",
      "macos_real_media_playback",
      "macos_multicam_sync_smoke",
      "macos_final_cut_open",
      "macos_team_gateway_lan_smoke",
      "macos_codesign_bundle",
      "windows_tauri_build",
      "windows_webview2_media_smoke",
      "windows_multicam_sync_smoke",
      "windows_team_gateway_lan_smoke",
      "windows_installer_smoke",
    ] as const;
    for (const gate of requiredNativeGates) {
      expect(parity.release_gates[gate]).toBe("required");
    }
  });
});
