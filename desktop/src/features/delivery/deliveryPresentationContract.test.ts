import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("editor-first delivery presentation", () => {
  it("shows snapshot preflight before invoking the final exporter", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    expect(workbench).toContain("buildTimelineDeliveryPreflight(snapshot)");
    expect(workbench).toContain("if (nextPreflight.blockers.length)");
    expect(workbench).toContain("交付前检查未通过");
  });

  it("does not promise unsupported independent A-track delivery", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    expect(workbench).toContain("linked asset audio only · v1");
    expect(workbench).toContain("非空独立 A-track");
    expect(workbench).not.toContain("独立音频片段会按 Timeline A-track");
  });

  it("only opens Final Cut directly when the artifact matches current Timeline authority", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    expect(workbench).toContain("sameTimelineAuthority(timelineSnapshot.authority, timelineReport.timeline_authority)");
    expect(workbench).toContain("disabled={!artifactCurrent}");
  });
});
