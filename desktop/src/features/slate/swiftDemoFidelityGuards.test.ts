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

  it("uses the same script-segment scene resolver for derived and manually added Takes", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    expect(slate).toContain("const mapped = mappedScene(review, take)");
    expect(slate).toContain("const mapped = review ? mappedScene(review, take) : null");
    expect(slate).toContain("const episode = review ? derivedEpisode(take, mapped)");
    expect(slate).toContain("script_scene_id: row.script_scene_id || mapped?.sceneId || \"\"");
    expect(slate).toContain("script_scene_id: mapped?.sceneId ?? \"\"");
    expect(slate).not.toContain("linkedScene(");
  });

  it("keeps a direct Slate assistant entry without shrinking Slate and does not advertise deferred dictation", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    const slate = source("./GoldenSlateWorkbench.tsx");
    const slateCss = source("./golden-slate.css");
    const experience = source("../production/product-experience.css");
    expect(workbench).toContain('const slateAssistantVisible = assistantOpen && page === "slate"');
    expect(workbench).toContain("assistantOpen={slateAssistantVisible}");
    expect(workbench).toContain("onToggleAssistant={() => setAssistantOpen((value) => !value)}");
    expect(workbench).toContain('slateAssistantVisible ? "slate-assistant-drawer" : ""');
    expect(slate).toContain("onToggleAssistant?: () => void");
    expect(slate).toContain('aria-label={assistantOpen ? "关闭小镜" : "打开小镜"}');
    expect(slate).toContain(">✦</button>");
    expect(experience).toContain(".has-slate-assistant .project-workbench-canvas { grid-template-columns: minmax(0, 1fr); }");
    expect(experience).toContain(".slate-assistant-drawer { position: absolute");
    expect(slate).not.toContain("quick-mic");
    expect(slateCss).not.toContain(".quick-mic");
    expect(slateCss).toContain("grid-template-columns: minmax(220px,1fr) auto 1px auto auto auto");
  });

  it("keeps the material and script workspace readable at Swift production density", () => {
    const css = source("../material-script/golden-material-script.css");
    expect(css).not.toContain("font-size: 7px");
    expect(css).not.toContain("font-size: 8px");
    expect(css).toContain(".golden-ms-title > span");
    expect(css).toContain("font-size: 10px");
    expect(css).toContain(".golden-ms-target-pane > header strong");
    expect(css).toContain("font-size: 11px");
    expect(css).toContain("grid-template-columns: 280px minmax(360px,1fr) 300px");
  });

  it("keeps Material Script on one chrome layer with explicit desktop appearance", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    const material = source("../material-script/GoldenMaterialScriptWorkbench.tsx");
    const css = source("../material-script/golden-material-script.css");
    const theme = source("../material-script/golden-material-script-theme.css");
    const main = source("../../main.tsx");
    const experience = source("../production/product-experience.css");
    expect(workbench).toContain('onBack={() => setPage("slate")}');
    expect(workbench).not.toContain("golden-secondary-workspace");
    expect(material).toContain("golden-ms-back");
    expect(material).toContain("‹ 场记");
    expect(experience).not.toContain("golden-secondary-return");
    expect(css).toContain('html[data-mirrororder-theme="light"] .golden-material-script');
    expect(css).toContain('html[data-mirrororder-theme="dark"] .golden-material-script');
    expect(theme).toContain('html[data-mirrororder-theme="light"] .golden-material-script .angle-card');
    expect(theme).toContain('html[data-mirrororder-theme="dark"] .golden-material-script .inspector-angle-tabs button');
    expect(main).toContain('import "./features/material-script/golden-material-script-theme.css"');
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
