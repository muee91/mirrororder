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
      "macos_fcp_integration",
    ] as const;

    for (const gate of required) {
      expect(parity.gates[gate].code_status).toMatch(/^implemented/);
      expect(parity.gates[gate].evidence.length).toBeGreaterThan(0);
    }
    expect(parity.desktop_primary_candidate).toBe(true);
  });

  it("does not allow physical SwiftUI retirement before native release gates", () => {
    expect(parity.swiftui_retirement_allowed).toBe(false);
    expect(parity.retirement_policy.swiftui_state).toBe("legacy_frozen_reference");
    expect(parity.retirement_policy.new_features_allowed_in_swiftui).toBe(false);
    expect(parity.retirement_policy.physical_delete_before_release_gates).toBe(false);

    const requiredNativeGates = [
      "macos_tauri_build",
      "macos_real_media_playback",
      "macos_final_cut_open",
      "macos_codesign_bundle",
      "windows_tauri_build",
      "windows_webview2_media_smoke",
      "windows_installer_smoke",
    ] as const;
    for (const gate of requiredNativeGates) {
      expect(parity.release_gates[gate]).toBe("required");
    }
  });
});
