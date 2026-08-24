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
    expect(parity.desktop_primary_candidate).toBe(true);
  });

  it("keeps heavy capabilities out of the project-tab dumping ground", () => {
    expect(parity.isolation_policy.production_project_tabs_are_parity_surfaces).toBe(true);
    expect(parity.isolation_policy.team_web_is_top_level_workspace).toBe(true);
    expect(parity.isolation_policy.heavy_capabilities_require_isolated_module_or_worktree).toBe(true);
    expect(parity.isolated_workstreams.runtime_packaging.branch).toBe("feat/desktop-v2-runtime-packaging");
    expect(parity.isolated_workstreams.runtime_packaging.status).toBe("isolated_blocker");
  });

  it("does not allow physical SwiftUI retirement before native release gates", () => {
    expect(parity.swiftui_retirement_allowed).toBe(false);
    expect(parity.retirement_policy.swiftui_state).toBe("legacy_frozen_reference");
    expect(parity.retirement_policy.new_features_allowed_in_swiftui).toBe(false);
    expect(parity.retirement_policy.physical_delete_before_release_gates).toBe(false);

    const requiredNativeGates = [
      "packaged_python_runtime",
      "macos_tauri_build",
      "macos_real_media_playback",
      "macos_final_cut_open",
      "macos_team_gateway_lan_smoke",
      "macos_codesign_bundle",
      "windows_tauri_build",
      "windows_webview2_media_smoke",
      "windows_team_gateway_lan_smoke",
      "windows_installer_smoke",
    ] as const;
    for (const gate of requiredNativeGates) {
      expect(parity.release_gates[gate]).toBe("required");
    }
  });
});