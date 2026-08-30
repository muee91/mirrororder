import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

describe("Swift golden product fidelity", () => {
  it("keeps editing out of the Production workspace and removes duplicate web navigation", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    const material = source("../material-script/GoldenMaterialScriptWorkbench.tsx");
    const experience = source("../production/product-experience.css");
    expect(workbench).not.toContain("TimelineWorkbench");
    expect(workbench).not.toContain("DeliveryWorkbench");
    expect(workbench).not.toContain("RoughCutWorkbench");
    expect(workbench).not.toContain("AssemblyWorkbench");
    expect(workbench).not.toContain('label: "剪辑"');
    expect(workbench).not.toContain("project-workbench-primary");
    expect(workbench).not.toContain("readProjectPage");
    expect(workbench).toContain('useState<ProductionPage>("slate")');
    expect(workbench).toContain("owns-chrome");
    expect(workbench).toContain('onBack={() => setPage("slate")}');
    expect(workbench).not.toContain("golden-secondary-workspace");
    expect(material).toContain("‹ 场记");
    expect(workbench).toContain("assistantVisible = assistantOpen && secondarySurface");
    expect(workbench).toContain("onOpenTeamReview ?? (() => setPage(\"watch\"))");
    expect(experience).toContain("grid-template-columns: minmax(0, 1fr) 312px");
    expect(experience).not.toContain("golden-secondary-return");
  });

  it("restores the multicam slate workflow rather than only its column labels", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    const css = source("./golden-slate.css");
    for (const label of [
      "A 机",
      "B 机",
      "C 机",
      "辅助 / 特殊",
      "加入 Take / 镜头",
      "团队审阅",
      "同场下一条",
      "同上",
      "空白",
      "已按剧本归位",
      "待标记 · 保持 XML 顺序",
      "I 设入点",
      "O 设出点",
      "第 {selected.episode} 集候选",
      "− 移除",
    ]) expect(slate).toContain(label);
    expect(slate).toContain("golden-take-picker");
    expect(slate).toContain("golden-status-control");
    expect(slate).toContain("removeAttachment");
    expect(slate).toContain("onDragDropEvent");
    expect(slate).toContain("slateMedia.resolveDrop");
    expect(slate).toContain("已把 T${take.take_index} 填入当前场记");
    expect(slate).toContain("row.record_id === selected.record_id || row.source_group_id !== take.group_id");
    expect(slate).toContain("take_number: take.take_index || null");
    expect(slate).toContain("shortcutActionsRef");
    expect(slate).toContain('globalThis.addEventListener("keydown", keydown)');
    expect(slate).toContain("}, []);");
    expect(slate).not.toContain("track.clips =");
    expect(css).toContain("height: 52px");
    expect(css).toContain("height: 38px");
    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain("grid-template-rows: minmax(150px,1fr) minmax(180px,1.15fr)");
  });

  it("maps script segments to real scenes before deciding placed versus pending", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    expect(slate).toContain("function mappedScene");
    expect(slate).toContain("scene.script_blocks.some((block) => wanted.has(block.segment_id))");
    expect(slate).toContain("script_scene_id: mapped?.sceneId ?? \"\"");
    expect(slate).toContain("function isPlacedDraft");
    expect(slate).toContain("draft.script_scene_id.trim() || draft.scene.trim()");
    expect(slate).toContain("take.automatic_state.episode_ids?.[0]");
    expect(slate).not.toContain("script_scene_id: take.effective_mapping.script_segment_ids[0]");
  });

  it("uses the frozen Swift media-card geometry while limiting live thumbnail pressure", () => {
    const card = source("../media/MirrorOrderMediaCard.tsx");
    const css = source("../media/mirrororder-media-card.css");
    const reviewAdapter = source("../material-script/AngleEvidenceCard.tsx");
    expect(css).toContain("width: 180px; height: 88px");
    expect(css).toContain("width: min(286px, 100%); height: 112px");
    expect(css).toContain("grid-template-columns: 70px");
    expect(css).toContain("grid-template-columns: 132px");
    expect(css).toContain("border: 2px solid");
    expect(card).toContain("IntersectionObserver");
    expect(card).toContain('rootMargin: "48px 96px"');
    expect(card).toContain("compact && compactPreviewActive");
    expect(card).toContain("previewReady");
    expect(card).toContain('video.addEventListener("seeked", markReady)');
    expect(card).toContain("sourceStart");
    expect(card).toContain("当前设备缺失");
    expect(css).toContain(".mo-media-thumb video.is-ready");
    expect(css).toContain(".mo-media-preview-fallback");
    expect(reviewAdapter).toContain("MirrorOrderMediaCard");
    expect(reviewAdapter).not.toContain("fixed-angle-card");
  });

  it("restores the fixed macOS-style project home and sidebar geometry plus project actions", () => {
    const app = source("../../app/App.tsx");
    const home = source("../projects/ProjectHome.tsx");
    const css = source("../projects/project-home.css");
    const library = source("../projects/ProjectLibrary.tsx");
    const libraryFidelity = source("../projects/project-library-fidelity.css");
    const activity = source("../projects/projectActivity.ts");
    const shell = source("../../styles.css");
    expect(app).toContain("<ProjectHome");
    expect(app).toContain("setSelectedProject(null)");
    expect(app).toContain("teamWorkbenchUrl");
    expect(app).toContain("deleteProject(project: ProjectSummary)");
    expect(app).toContain("useProjectActivities");
    expect(home).toContain("全部项目");
    expect(home).toContain("FCPXML");
    expect(home).toContain("原始素材");
    expect(home).toContain("onContextMenu");
    expect(home).toContain("团队审阅");
    expect(home).toContain("复制局域网协作链接");
    expect(home).toContain("本机素材 / 换素材盘");
    expect(home).toContain("永久删除项目…");
    expect(home).toContain("project-activity-spinner");
    expect(activity).toContain("ProjectTaskClient");
    expect(activity).toContain('state: "active"');
    expect(activity).toContain('state: "failed"');
    expect(css).toContain("grid-template-columns: repeat(auto-fill, 260px)");
    expect(css).toContain("width: 260px; height: 176px");
    expect(css).toContain("grid-template-rows: 108px 68px");
    expect(library).toContain('import "./project-library-fidelity.css"');
    expect(library).toContain("workspace.projects.slice(0, 8)");
    expect(library).toContain("复制局域网协作链接");
    expect(library).toContain("永久删除项目…");
    expect(library).not.toContain('<button type="button" className={utilityActive === "team"');
    expect(libraryFidelity).toContain("min-height: 38px");
    expect(libraryFidelity).not.toContain("::before");
    expect(shell).toContain("grid-template-columns: 216px minmax(0, 1fr)");
  });

  it("keeps explicit file-drop identity path-free and human-save gated", () => {
    const api = source("../../api/slateMedia.ts");
    const slate = source("./GoldenSlateWorkbench.tsx");
    expect(api).toContain("device_paths_exposed !== false");
    expect(api).toContain("/slate-media-resolve");
    expect(slate).toContain("保存后才写入项目");
    expect(slate).not.toContain("source_media_path");
    expect(slate).not.toContain("resolved_media_path");
  });

  it("keeps Slate transport keys without a permanent teaching badge", () => {
    const shortcuts = source("./SlatePlaybackShortcuts.tsx");
    expect(shortcuts).toContain('key !== "j" && key !== "k" && key !== "l" && key !== " "');
    expect(shortcuts).toContain("Math.max(0, video.currentTime - 1)");
    expect(shortcuts).toContain("return null");
    expect(shortcuts).not.toContain("slate-playback-shortcut-hint");
    expect(shortcuts).not.toContain("playbackRate = -");
  });
});
