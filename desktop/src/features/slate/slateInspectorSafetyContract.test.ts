import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf-8");
}

describe("Slate inspector safety contract", () => {
  it("does not present an automatic derived projection as a deletable human record", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");

    expect(slate).toContain("const selectedPersisted = Boolean(selected && board?.records[selected.record_id])");
    expect(slate).toContain("const selectedCanDelete = Boolean(selected && (selectedPersisted || !selected.derived))");
    expect(slate).toContain("if (!persisted && selected.derived)");
    expect(slate).toContain("自动派生场记来自 Review Take，不能在这里删除");
    expect(slate).toContain("{selectedCanDelete ? <button");
    expect(slate).toContain('selectedPersisted ? "删除人工场记…" : "移除草稿…"');
    expect(slate).not.toContain(">删除场记</button>");
  });

  it("turns an unreadable inspector video into an explicit fallback instead of browser failure chrome", () => {
    const slate = source("./GoldenSlateWorkbench.tsx");

    expect(slate).toContain("const [playbackFailedClipId, setPlaybackFailedClipId] = useState(\"\")");
    expect(slate).toContain("const selectedPlaybackFailed = Boolean(selectedPlaybackKey && playbackFailedClipId === selectedPlaybackKey)");
    expect(slate).toContain("selectedAngle.playback.available !== false && !selectedPlaybackFailed");
    expect(slate).toContain("onError={() => setPlaybackFailedClipId(selectedPlaybackKey)}");
    expect(slate).toContain("当前设备无法读取或解码这个素材");
    expect(slate).toContain("setPlaybackFailedClipId(\"\")");
  });
});
