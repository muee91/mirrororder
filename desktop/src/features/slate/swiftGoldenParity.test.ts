import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

describe("Swift golden product fidelity", () => {
  it("keeps the Swift usability baseline while current navigation has exactly four dedicated workspace authorities", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    const material = source("../material/MaterialWorkspace.tsx");
    const script = source("../script/ScriptWorkspace.tsx");
    for (const label of ["素材", "剧本", "时间线", "审阅"]) expect(workbench).toContain(`label: "${label}"`);
    expect(workbench).toContain("<MaterialWorkspace");
    expect(workbench).toContain("<ScriptWorkspace");
    expect(workbench).toContain("<TimelineWorkbench");
    expect(workbench).toContain("<ReviewWorkspace");
    expect(workbench).toContain('{ page: "timeline", label: "时间线" }');
    expect(workbench).toContain('if (page === "rough-cut" || page === "assembly" || page === "delivery") return "timeline";');
    expect(workbench).toContain("professional-project-toolbar");
    expect(workbench).toContain("readProjectPage");
    expect(workbench).toContain('useState<ProductionPage>(() => safeProductionPage(readProjectPage(project.project_id)))');
    expect(workbench).toContain("owns-chrome");
    expect(workbench).toContain("const assistantVisible = assistantOpen;");
    expect(workbench).toContain("professional-assistant-toggle");
    expect(workbench).toContain('className="assistant-context-drawer"');
    expect(workbench).not.toContain("MaterialScriptWorkbench");
    expect(workbench).not.toContain("DeliveryWorkbench");
    expect(workbench).not.toContain("RoughCutWorkbench");
    expect(workbench).not.toContain("AssemblyWorkbench");
    expect(workbench).not.toContain("professional-secondary-nav");
    expect(material).toContain('const MATERIAL_VIEWS: Array<{ view: Exclude<MaterialView, "repair">');
    expect(material).toContain('view === "repair"');
    expect(script).toContain("PROJECTION_OPTIONS");
    expect(script).toContain('{ value: "coverage", label: "覆盖" }');
  });

  it("restores the multicam slate workflow rather than only its column labels", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    const row = source("./SlateRow.tsx");
    const takeCard = source("../material-script/TakeCard.tsx");
    const css = source("./golden-slate.css");
    for (const label of ["A 机", "B 机", "C 机", "辅助 / 特殊"]) expect(row).toContain(label);
    for (const label of [
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
    expect(takeCard).toContain("takeCameraSlots");
    expect(takeCard).toContain("STABLE_CAMERA_SLOTS.map");
    expect(takeCard).toContain("data-camera-tone={slot.tone}");
    expect(slate).toContain("golden-take-picker");
    expect(row).toContain("golden-status-control");
    expect(slate).toContain("removeAttachment");
    expect(slate).toContain("onDragDropEvent");
    expect(slate).toContain("slateMedia.resolveDrop");
    expect(slate).toContain("已把 T${take.take_index} 填入当前场记");
    expect(slate).toContain("row.record_id === selected.record_id || row.source_group_id !== take.group_id");
    expect(slate).toContain("take_number: take.take_index || null");
    expect(slate).toContain("onToggleAssistant");
    expect(slate).toContain('aria-label={assistantOpen ? "关闭小镜" : "打开小镜"}');
    expect(slate).toContain(">✦</button>");
    expect(slate).not.toContain("quick-mic");
    expect(css).not.toContain(".quick-mic");
    expect(css).toContain("grid-template-columns: minmax(220px,1fr) auto 1px auto auto auto");
    expect(slate).toContain("shortcutActionsRef");
    expect(slate).toContain('globalThis.addEventListener("keydown", keydown)');
    expect(slate).toContain('if (event.key === "Escape" && takePickerOpen)');
    expect(slate).toContain("}, [takePickerOpen]);");
    expect(slate).not.toContain("track.clips =");
    expect(css).toContain("height: 52px");
    expect(css).toContain("height: 38px");
    expect(css).toContain("@media (max-width: 1320px)");
    expect(css).toContain("@media (max-width: 1208px)");
    expect(css).toContain("grid-template-columns: minmax(620px,1fr) 285px");
    expect(css).toContain("grid-template-rows: minmax(150px,1fr) minmax(180px,1.15fr)");
  });

  it("maps script segments to real scenes before deciding placed versus pending", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    expect(slate).toContain("function mappedScene");
    expect(slate).toContain("scene.script_blocks.some((block) => wanted.has(block.segment_id))");
    expect(slate).toContain("script_scene_id: mapped?.sceneId ?? \"\"");
    expect(slate).toContain("const mapped = review ? mappedScene(review, take) : null");
    expect(slate).toContain("const episode = review ? derivedEpisode(take, mapped)");
    expect(slate).toContain("script_scene_id: row.script_scene_id || mapped?.sceneId || \"\"");
    expect(slate).not.toContain("linkedScene(");
    expect(slate).toContain("function isPlacedDraft");
    expect(slate).toContain("draft.script_scene_id.trim() || draft.scene.trim()");
    expect(slate).toContain("take.automatic_state.episode_ids?.[0]");
    expect(slate).not.toContain("script_scene_id: take.effective_mapping.script_segment_ids[0]");
  });

  it("keeps visible Slate order, scene identity, row numbering and delete semantics aligned", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    const row = source("./SlateRow.tsx");
    expect(slate).toContain("function sceneOrderValue");
    expect(slate).toContain("draft.scene.trim() || draft.script_scene_id.trim()");
    expect(slate).toContain("function displayOrder");
    expect(slate).toContain("const displayedDrafts = displayOrder(drafts)");
    expect(slate).toContain('script_scene_id: selected?.script_scene_id ?? ""');
    expect(slate).toContain("displayedDrafts[visualIndex - 1]");
    expect(slate).toContain("script_scene_id: previous.script_scene_id");
    expect(slate).toContain("const rowNumber = displayIndex >= 0 ? displayIndex + 1 : 0");
    expect(row).toContain("placeholder={row.mappedScenePlaceholder}");
    expect(slate).toContain("selected.scene || selected.script_scene_id || \"—\"");
    expect(slate).toContain("requestDeleteSelected");
    expect(slate).toContain("globalThis.confirm(prompt)");
    expect(slate).toContain("删除人工场记…");
    expect(slate).toContain("移除草稿…");
    expect(slate).not.toContain("drafts.indexOf(draft)");
    expect(slate).not.toContain("drafts[selectedIndex - 1]");
  });

  it("uses the frozen Swift media-card geometry while limiting live thumbnail pressure", () => {
    const card = source("../media/MirrorOrderMediaCard.tsx");
    const css = source("../media/mirrororder-media-card.css");
    const reviewAdapter = source("../material-script/AngleEvidenceCard.tsx");
    expect(css).toContain("width: 180px; height: 88px");
    expect(css).toContain("width: min(300px, 100%); height: 124px");
    expect(css).toContain("grid-template-columns: 70px");
    expect(css).toContain("grid-template-columns: 136px");
    expect(css).toContain("border: 1px solid");
    expect(card).toContain("IntersectionObserver");
    expect(card).toContain('rootMargin: "48px 96px"');
    expect(card).toContain("compact && compactPreviewActive");
    expect(card).toContain("previewReady");
    expect(card).toContain('video.addEventListener("seeked", markReady)');
    expect(card).toContain("sourceStart");
    expect(card).toContain("设备缺失");
    expect(css).toContain(".mo-media-thumb video.is-ready");
    expect(css).toContain(".mo-media-preview-fallback");
    expect(reviewAdapter).toContain("MirrorOrderMediaCard");
    expect(reviewAdapter).not.toContain("fixed-angle-card");
  });

  it("separates Workspace Home, project management and project production navigation", () => {
    const app = source("../../app/App.tsx");
    const workspaceHome = source("../projects/WorkspaceHome.tsx");
    const home = source("../projects/ProjectHome.tsx");
    const lifecycle = source("../projects/ProjectLifecyclePanel.tsx");
    const library = source("../projects/ProjectLibrary.tsx");
    const activity = source("../projects/projectActivity.ts");
    const redesign = source("../../app/mirrororder-redesign.css");
    expect(app).toContain("<WorkspaceHome");
    expect(app).toContain("<ProjectHome");
    expect(app).toContain('type AppSurface = "home" | "projects" | "production" | "status" | "team" | "settings"');
    expect(app).toContain('setSurface("home")');
    expect(app).toContain("teamWorkbenchUrl");
    expect(app).toContain("deleteProject(project: ProjectSummary)");
    expect(app).toContain("useProjectActivities");
    expect(workspaceHome).toContain("今晚继续哪里？");
    expect(workspaceHome).toContain("最近项目");
    expect(workspaceHome).toContain("状态中心");
    expect(home).toContain("管理工作区内的制作项目");
    expect(home).toContain("<ProjectLifecyclePanel");
    expect(home).toContain("project-home-list");
    expect(home).toContain("project-home-more");
    expect(home).toContain("aria-haspopup=\"menu\"");
    expect(home).toContain("onContextMenu");
    expect(home).toContain("团队审阅");
    expect(home).toContain("复制局域网协作链接");
    expect(home).toContain("本机素材 / 换素材盘");
    expect(home).toContain("永久删除项目…");
    expect(home).toContain("project-activity-spinner");
    expect(activity).toContain("ProjectTaskClient");
    expect(activity).toContain('state: "active"');
    expect(activity).not.toContain('state: "failed"');
    expect(lifecycle).toContain(">新建项目</button>");
    expect(lifecycle).toContain("创建并整理");
    expect(lifecycle).toContain("client.preflightProject(payload())");
    expect(library).toContain('aria-label="主导航"');
    expect(library).toContain('aria-label="系统导航"');
    expect(library).toContain("制作区在项目画布顶部切换。");
    expect(library).toContain(">团队审阅</button>");
    expect(library).toContain("workspace.projects.filter((project) => project.project_id !== selectedProjectId).slice(0, 3)");
    expect(library).toContain("最近使用");
    expect(library).toContain("复制局域网协作链接");
    expect(library).toContain("永久删除项目…");
    expect(redesign).toContain("grid-template-columns: 208px minmax(0, 1fr)");
    expect(redesign).toContain(".workspace-home-grid");
    expect(redesign).toContain(".project-home-list");
    expect(redesign).toContain("grid-template-columns: repeat(2, minmax(0, 1fr))");
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
