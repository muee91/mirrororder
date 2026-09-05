import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const decisionSource = readFileSync(new URL("../review/ReviewDecisionPanel.tsx", import.meta.url), "utf8");
const apiSource = readFileSync(new URL("../../api/planning.ts", import.meta.url), "utf8");
const retiredPanel = fileURLToPath(new URL("./TakeEvidencePanels.tsx", import.meta.url));

describe("assignment editorial boundary contract", () => {
  it("keeps assignment-level decisions out of the Desktop Review workflow", () => {
    expect(existsSync(retiredPanel)).toBe(false);
    expect(decisionSource).toContain("剧本段级团队反馈");
    expect(decisionSource).toContain("审阅页不展开剧本段级裁决");
    expect(decisionSource).not.toContain('decide("assignment"');
    expect(decisionSource).toContain('targetKind: "group"');
  });

  it("keeps the revision-safe assignment API contract available outside this Desktop surface", () => {
    expect(apiSource).toContain('targetKind: "group" | "assignment"');
    expect(apiSource).toContain("segmentId?: string");
    expect(apiSource).toContain("expectedRevision: number");
  });
});
