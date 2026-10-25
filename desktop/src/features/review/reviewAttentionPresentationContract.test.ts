import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const attention = read("./reviewAttention.ts");
const review = read("./ReviewWorkspace.tsx");
const decision = read("./ReviewDecisionPanel.tsx");
const inspector = read("../material-script/TakeInspector.tsx");
const home = read("../projects/ProjectHome.tsx");

describe("review attention and decision presentation contract", () => {
  it("returns unresolved team opinions to the Review attention filter", () => {
    expect(attention).toContain("collaborationAttention");
    expect(attention).toContain("labels.push(...collaboration.labels)");
    expect(attention).toContain("export function reviewTakeAttention");
    expect(review).toContain('{ value: "attention", label: "需关注" }');
    expect(review).toContain("selectedAttention.labels.slice(0, 4)");
  });

  it("tiers the attention count so 需关注 stays explainable in degenerate data", () => {
    expect(attention).toContain('export type ReviewAttentionTier = "blocking" | "stale" | "watch"');
    expect(attention).toContain('issue.severity === "error"');
    expect(review).toContain("attentionTiers.blocking");
    expect(review).toContain("attentionTiers.stale");
    expect(review).toContain("attentionTiers.watch");
  });

  it("moves overview signals to Project Home without creating another Review workbench", () => {
    expect(attention).toContain("export function reviewProjectSummary");
    expect(home).toContain("reviewProjectSummary(await host.reviewModel(project.project_id))");
    expect(home).toContain("review.unmappedCount");
    expect(home).toContain("review.scriptGapCount");
  });

  it("keeps Take-level Final Editorial Decision in Review instead of the shared inspector", () => {
    expect(review).toContain("<ReviewDecisionPanel");
    expect(decision).toContain('targetKind: "group"');
    expect(decision).not.toContain('decide("assignment"');
    expect(inspector).not.toContain("EditorialDecisionPanel");
    expect(inspector).not.toContain("showEditorial");
    expect(attention).toContain("最终决定后收到新意见");
  });
});
