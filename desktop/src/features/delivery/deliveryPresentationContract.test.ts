import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("editor-first delivery presentation", () => {
  it("shows snapshot preflight before invoking either final NLE exporter", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    expect(workbench).toContain("buildTimelineDeliveryPreflight(snapshot)");
    expect(workbench).toContain("if (nextPreflight.blockers.length)");
    expect(workbench).toContain("交付前检查未通过");
    expect(workbench).toContain("exportPremiere(projectId, snapshot)");
  });

  it("describes v2 delivery semantics in Chinese product language", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    expect(workbench).toContain("独立音频片段");
    expect(workbench).toContain("保留多机位容器");
    expect(workbench).toContain("时间线标记");
    expect(workbench).not.toContain("linked asset audio only · v1");
    expect(workbench).not.toContain("flatten 为普通 asset-clip");
  });

  it("only opens Final Cut directly when the artifact matches current Timeline authority", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    expect(workbench).toContain("sameTimelineAuthority(timelineSnapshot.authority, timelineReport.timeline_authority)");
    expect(workbench).toContain("disabled={!artifactCurrent}");
  });

  it("exposes Premiere XML as a separate authority-tracked artifact", () => {
    const workbench = read("./DeliveryWorkbench.tsx");
    const client = read("../../api/delivery.ts");
    expect(workbench).toContain("premiereReport.premiere_xmeml");
    expect(workbench).toContain("premiereArtifactCurrent");
    expect(workbench).toContain("Premiere Pro");
    expect(client).toContain("/timeline-premiere-export");
    expect(client).toContain("exportPremiere(projectId: string, snapshot: TimelineSnapshot)");
  });
});
