import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

describe("Swift golden product parity", () => {
  it("keeps the multicam slate as a real production table with inspector actions", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");
    for (const label of ["多机位电子场记", "A机", "B机", "C机", "辅助 / 特殊", "从 Take 加入", "同场下一条", "同上", "空白", "I 设入点", "O 设出点", "保存当前行"]) {
      expect(slate).toContain(label);
    }
    expect(slate).toContain("SlateRecordClient");
    expect(slate).toContain("MirrorOrderMediaCard");
    expect(slate).toContain("onDragDropEvent");
    expect(slate).toContain("slateMedia.resolveDrop");
    expect(slate).toContain("preferred clip 是场记首选机位，不是 Editorial Best");
    expect(slate).not.toContain("track.clips =");
  });

  it("uses one shared media-card visual contract across Slate, Take and Inspector", () => {
    const card = source("../media/MirrorOrderMediaCard.tsx");
    const css = source("../media/mirrororder-media-card.css");
    const reviewAdapter = source("../material-script/AngleEvidenceCard.tsx");
    expect(card).toContain("当前设备缺失 / 不可播放");
    expect(card).toContain("场记首选机位，不等于 Editorial Best");
    expect(css).toContain("width: 154px; height: 54px");
    expect(css).toContain("min-height: 92px");
    expect(css).toContain("border: 2px solid");
    expect(css).toContain("mo-media-selected");
    expect(reviewAdapter).toContain("MirrorOrderMediaCard");
    expect(reviewAdapter).toContain("mediaCardFromAngle(angle)");
    expect(reviewAdapter).not.toContain("fixed-angle-card");
    expect(reviewAdapter).not.toContain("angle-media-state");
  });

  it("restores project-home-first navigation instead of auto-opening the last project", () => {
    const app = source("../../app/App.tsx");
    const home = source("../projects/ProjectHome.tsx");
    const library = source("../projects/ProjectLibrary.tsx");
    expect(app).toContain("<ProjectHome");
    expect(app).toContain("setSelectedProject(null)");
    expect(app).toContain("恢复完成后先进入项目主页，不会自动钻入上次项目");
    expect(home).toContain("全部项目");
    expect(home).toContain("project-home-grid");
    expect(library).toContain("项目主页");
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

  it("restores explicit Slate transport keys without pretending reverse video is supported", () => {
    const shortcuts = source("./SlatePlaybackShortcuts.tsx");
    expect(shortcuts).toContain("Space 播放/暂停");
    expect(shortcuts).toContain("J 后退 1 秒");
    expect(shortcuts).toContain("K 暂停");
    expect(shortcuts).toContain("L 播放");
    expect(shortcuts).toContain("Math.max(0, video.currentTime - 1)");
    expect(shortcuts).not.toContain("playbackRate = -");
  });
});
