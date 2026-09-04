import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("editor Chinese product language", () => {
  it("uses Chinese names for the primary editing surfaces", () => {
    const timeline = read("./TimelineWorkbench.tsx");
    const monitors = read("./EditorMonitors.tsx");
    expect(timeline).toContain("剪辑工作台");
    expect(timeline).toContain("初始顺片");
    expect(timeline).toContain("换镜次");
    expect(timeline).toContain("智能建议");
    expect(timeline).toContain("插入视频");
    expect(timeline).toContain("覆盖音频");
    expect(monitors).toContain("素材监看");
    expect(monitors).toContain("节目监看");
    expect(monitors).toContain("音频波形");
  });

  it("does not expose old English monitor or source-operation labels", () => {
    const timeline = read("./TimelineWorkbench.tsx");
    const monitors = read("./EditorMonitors.tsx");
    expect(monitors).not.toContain(">Source Monitor<");
    expect(monitors).not.toContain(">Program Monitor<");
    expect(timeline).not.toContain(">Insert Video");
    expect(timeline).not.toContain(">Overwrite Video");
  });
});
