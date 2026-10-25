import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function editorSurfaceText(): string {
  return [
    read("./TimelineWorkbenchView.tsx"),
    read("./TimelineInitialAssembly.tsx"),
    read("./TimelineInspectorPanel.tsx"),
    read("./TimelineSuggestionsPanel.tsx"),
    read("./TimelineSourcePanel.tsx"),
  ].join("\n");
}

describe("editor Chinese product language", () => {
  it("uses Chinese names for the primary assembly and delivery surfaces", () => {
    const timeline = editorSurfaceText();
    const monitors = read("./EditorMonitors.tsx");
    expect(timeline).toContain("组接与导出");
    expect(timeline).toContain("初始顺片");
    expect(timeline).toContain("换镜次");
    expect(timeline).toContain("智能建议");
    expect(timeline).toContain("素材监看");
    expect(monitors).toContain("素材监看");
    expect(monitors).toContain("节目监看");
    expect(monitors).toContain("音频波形");
  });

  it("keeps frame-level fine editing out of the timeline workspace", () => {
    const timeline = editorSurfaceText();
    expect(timeline).not.toContain(">插入视频");
    expect(timeline).not.toContain(">覆盖音频");
    expect(timeline).not.toContain(">波纹删除");
    expect(timeline).not.toContain(">在播放头切分");
    expect(timeline).not.toContain(">撤销");
    expect(timeline).not.toContain(">重做");
    expect(timeline).not.toContain("精修与技术操作");
  });

  it("does not expose old English monitor or source-operation labels", () => {
    const timeline = editorSurfaceText();
    const monitors = read("./EditorMonitors.tsx");
    expect(monitors).not.toContain(">Source Monitor<");
    expect(monitors).not.toContain(">Program Monitor<");
    expect(timeline).not.toContain(">Insert Video");
    expect(timeline).not.toContain(">Overwrite Video");
  });
});
