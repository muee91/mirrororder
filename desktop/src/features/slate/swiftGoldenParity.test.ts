import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

describe("Swift golden product fidelity", () => {
  it("keeps editing out of the Production workspace and removes duplicate web navigation", () => {
    const workbench = source("../production/ProjectWorkbench.tsx");
    expect(workbench).not.toContain("TimelineWorkbench");
    expect(workbench).not.toContain("DeliveryWorkbench");
    expect(workbench).not.toContain("RoughCutWorkbench");
    expect(workbench).not.toContain("AssemblyWorkbench");
    expect(workbench).not.toContain('label: "剪辑"');
    expect(workbench).not.toContain("project-workbench-primary");
    expect(workbench).toContain("owns-chrome");
    expect(workbench).toContain("‹ 返回多机位场记");
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
    expect(slate).not.toContain("track.clips =");
    expect(css).toContain("height: 52px");
    expect(css).toContain("height: 38px");
    expect(css).toContain("grid-template-rows: minmax(150px,1fr) minmax(180px,1.15fr)");
  });

  it("uses the frozen Swift media-card geometry and real source thumbnails", () => {
    const card = source("../media/MirrorOrderMediaCard.tsx");
    const css = source("../media/mirrororder-media-card.css");
    const reviewAdapter = source("../material-script/AngleEvidenceCard.tsx");
    expect(css).toContain("width: 180px; height: 88px");
    expect(css).toContain("width: min(286px, 100%); height: 112px");
    expect(css).toContain("grid-template-columns: 70px");
    expect(css).toContain("grid-template-columns: 132px");
    expect(css).toContain("border: 2px solid");
    expect(card).toContain("compact || showPreview");
    expect(card).toContain("source_start");
    expect(card).toContain("当前设备缺失");
    expect(reviewAdapter).toContain("MirrorOrderMediaCard");
    expect(reviewAdapter).not.toContain("fixed-angle-card");
  });

  it("restores the fixed macOS-style project home and sidebar geometry", () => {
    const app = source("../../app/App.tsx");
    const home = source("../projects/ProjectHome.tsx");
    const css = source("../projects/project-home.css");
    const library = source("../projects/ProjectLibrary.tsx");
    const shell = source("../../styles.css");
    expect(app).toContain("<ProjectHome");
    expect(app).toContain("setSelectedProject(null)");
    expect(home).toContain("全部项目");
    expect(home).toContain("FCPXML");
    expect(home).toContain("原始素材");
    expect(css).toContain("grid-template-columns: repeat(auto-fill, 260px)");
    expect(css).toContain("width: 260px; height: 176px");
    expect(css).toContain("grid-template-rows: 108px 68px");
    expect(library).toContain('import "./project-library-fidelity.css"');
    expect(library).toContain("project-row-icon");
    expect(library).toContain("待处理");
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
