import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

describe("Swift Demo fidelity guards", () => {
  it("keeps unconfirmed automatic proposals out of placed Slate rows", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    expect(slate).toContain("function automaticMappingConfirmed");
    expect(slate).toContain('take.automatic_state.status === "auto_confirmed"');
    expect(slate).toContain('take.automatic_state.status === "ai_confirmed"');
    expect(slate).toContain("automaticMappingConfirmed(take) ? take.automatic_state.script_segment_ids ?? [] : []");
    expect(slate).toContain("const confirmedAutomaticEpisode = automaticMappingConfirmed(take)");
    expect(slate).toContain("automaticMappingConfirmed(take) && take.automatic_state.episode_ids?.includes(episode)");
    expect(slate).not.toContain("const ids = effectiveIds.length ? effectiveIds : take.automatic_state.script_segment_ids");
  });

  it("keeps the material and script workspace readable at Swift production density", () => {
    const css = source("../material-script/golden-material-script.css");
    expect(css).not.toContain("font-size: 7px");
    expect(css).not.toContain("font-size: 8px");
    expect(css).toContain(".golden-ms-toolbar > div:first-child > span");
    expect(css).toContain("font-size: 10px");
    expect(css).toContain(".golden-ms-target-pane > header strong");
    expect(css).toContain("font-size: 11px");
    expect(css).toContain("grid-template-columns: 280px minmax(360px,1fr) 300px");
  });

  it("aligns the native and DOM minimum window with the existing Golden layouts", () => {
    const tauri = source("../../../src-tauri/tauri.conf.json");
    const shell = source("../../styles.css");
    expect(tauri).toContain('"width": 1360');
    expect(tauri).toContain('"height": 860');
    expect(tauri).toContain('"minWidth": 1180');
    expect(tauri).not.toContain('"minWidth": 960');
    expect(shell).toContain("min-width: 1180px");
    expect(shell).not.toContain("min-width: 1040px");
    expect(shell).toContain("grid-template-columns: 216px minmax(0, 1fr)");
  });
});
