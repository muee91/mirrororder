import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const panelSource = readFileSync(new URL("./TakeEvidencePanels.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../../api/planning.ts", import.meta.url), "utf8");

describe("assignment editorial return-flow contract", () => {
  it("surfaces assignment opinions beside the host-local final decision controls", () => {
    expect(panelSource).toContain("具体剧本段反馈");
    expect(panelSource).toContain("assignmentRows(payload, groupId)");
    expect(panelSource).toContain('decide("assignment", state, row.segmentId)');
    expect(panelSource).toContain("Take 级与剧本段级决定都与 Team Web 的个人意见");
  });

  it("uses the existing revision-safe assignment decision API", () => {
    expect(apiSource).toContain('targetKind: "group" | "assignment"');
    expect(apiSource).toContain("segmentId?: string");
    expect(apiSource).toContain("expectedRevision: number");
    expect(panelSource).toContain("expectedRevision: payload.revision");
  });
});
