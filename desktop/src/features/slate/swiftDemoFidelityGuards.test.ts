import { existsSync, readFileSync } from "node:fs";
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

  it("uses the same script-segment scene resolver for derived and manually added Takes", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    expect(slate).toContain("const mapped = mappedScene(review, take)");
    expect(slate).toContain("const mapped = review ? mappedScene(review, take) : null");
    expect(slate).toContain("const episode = review ? derivedEpisode(take, mapped)");
    expect(slate).toContain("script_scene_id: row.script_scene_id || mapped?.sceneId || \"\"");
    expect(slate).toContain("script_scene_id: mapped?.sceneId ?? \"\"");
    expect(slate).not.toContain("linkedScene(");
  });

  it("keeps the assistant in the professional project toolbar without advertising deferred dictation", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    const slate = source("./GoldenSlateWorkbench.tsx");
    const slateCss = source("./golden-slate.css");
    const experience = source("../production/product-experience.css");
    expect(workbench).toContain("const assistantVisible = assistantOpen;");
    expect(workbench).toContain("professional-assistant-toggle");
    expect(workbench).toContain("aria-pressed={assistantOpen}");
    expect(workbench).toContain('className="assistant-context-drawer"');
    expect(experience).toContain(".has-assistant-drawer .project-workbench-canvas");
    expect(experience).toContain(".assistant-context-drawer");
    expect(slate).not.toContain("quick-mic");
    expect(slateCss).not.toContain(".quick-mic");
    expect(slateCss).toContain("grid-template-columns: minmax(220px,1fr) auto 1px auto auto auto");
  });

  it("keeps Material and Script readable at the Swift usability floor without reviving shared-workbench styling", () => {
    const materialCss = source("../material/material-workspace.css");
    const scriptCss = source("../script/script-workspace.css");
    for (const css of [materialCss, scriptCss]) {
      expect(css).toContain("var(--mo-");
      expect(css).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    }
    expect(materialCss).toContain(".material-domain-bar");
    expect(materialCss).toContain("min-height: 52px");
    expect(materialCss).toContain("font-size: var(--mo-font-xs, 10px)");
    expect(materialCss).toContain("font-size: var(--mo-font-sm, 11px)");
    expect(scriptCss).toContain(".script-command-bar");
    expect(scriptCss).toContain("grid-template-columns: auto minmax(220px, 1fr) auto");
    expect(scriptCss).toContain("font-size: var(--mo-font-xs, 10px)");
    expect(scriptCss).toContain("font-size: var(--mo-font-sm, 11px)");
  });

  it("keeps dedicated workspace chrome and explicit desktop appearance after retiring MaterialScript", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    const material = source("../material/MaterialWorkspace.tsx");
    const script = source("../script/ScriptWorkspace.tsx");
    const main = source("../../main.tsx");
    const experience = source("../production/product-experience.css");
    expect(workbench).toContain("<MaterialWorkspace");
    expect(workbench).toContain("<ScriptWorkspace");
    expect(workbench).toContain("<TimelineWorkbench");
    expect(workbench).toContain("<ReviewWorkspace");
    expect(workbench).not.toContain("MaterialScriptWorkbench");
    expect(workbench).not.toContain("professional-secondary-nav");
    expect(material).toContain('data-material-view={view}');
    expect(script).toContain('aria-label="剧本集数"');
    expect(experience).not.toContain("golden-secondary-return");
    expect(main).not.toContain("golden-material-script-theme.css");
    expect(existsSync(new URL("../material-script/GoldenMaterialScriptWorkbench.tsx", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../material-script/golden-material-script.css", import.meta.url))).toBe(false);
    expect(existsSync(new URL("../material-script/golden-material-script-theme.css", import.meta.url))).toBe(false);
  });

  it("does not mount the legacy Review Slate workload while its details is collapsed", () => {
    const helper = source("./SlateWorkbench.tsx");
    expect(helper).toContain('host?.closest("details")');
    expect(helper).toContain('details.addEventListener("toggle", sync)');
    expect(helper).toContain("expanded ? <SlateWorkbenchContent {...props} /> : null");
    expect(helper).toContain("function SlateWorkbenchContent");
    expect(helper).not.toContain("export function SlateWorkbench({ baseUrl, projectId }: Props)");
  });

  it("does not poll every project at active-task cadence", () => {
    const activity = source("../projects/projectActivity.ts");
    expect(activity).toContain("const ACTIVE_POLL_MS = 2000");
    expect(activity).toContain("const IDLE_FULL_POLL_MS = 15000");
    expect(activity).toContain("ACTIVE_TICKS_BEFORE_FULL_REFRESH");
    expect(activity).toContain("refreshActive(projectIds)");
    expect(activity).toContain("activeMonitor(active, 0)");
    expect(activity).not.toContain("active ? 1000 : 8000");
  });

  it("aligns the native and DOM minimum window with a Slate layout that fits it", () => {
    const tauri = source("../../../src-tauri/tauri.conf.json");
    const shell = source("../../styles.css");
    const slateCss = source("./golden-slate.css");
    const experience = source("../production/product-experience.css");
    expect(tauri).toContain('"width": 1360');
    expect(tauri).toContain('"height": 860');
    expect(tauri).toContain('"minWidth": 1180');
    expect(tauri).not.toContain('"minWidth": 960');
    expect(shell).toContain("min-width: 1180px");
    expect(shell).not.toContain("min-width: 1040px");
    expect(shell).toContain("grid-template-columns: 216px minmax(0, 1fr)");
    expect(slateCss).toContain("@media (max-width: 1208px)");
    expect(slateCss).toContain("grid-template-columns: minmax(620px,1fr) 285px");
    expect(experience).not.toContain(".project-workbench-main.owns-chrome .golden-slate-workbench.has-inspector .golden-slate-body");
    const fullInspectorThreshold = 216 + 680 + 312;
    expect(fullInspectorThreshold).toBe(1208);
    const minimumStageWidth = 1180 - 216;
    expect(620 + 285).toBeLessThanOrEqual(minimumStageWidth);
  });
});
