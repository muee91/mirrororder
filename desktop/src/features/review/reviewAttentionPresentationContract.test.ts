import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const attention = read("./reviewAttention.ts");
const watch = read("../material-script/MaterialScriptWorkbench.tsx");
const inspector = read("../material-script/TakeInspector.tsx");
const home = read("../projects/ProjectHome.tsx");

describe("review collaboration return-flow contract", () => {
  it("returns unresolved team opinions to the watch attention filter", () => {
    expect(attention).toContain("collaborationAttention");
    expect(attention).toContain("labels.push(...collaboration.labels)");
    expect(attention).toContain("export function reviewTakeAttention");
    expect(watch).toContain('{ value: "attention", label: "需关注" }');
    expect(inspector).toContain("attention.labels.slice(0, 4)");
  });

  it("moves overview signals to Project Home without creating another Review workbench", () => {
    expect(attention).toContain("export function reviewProjectSummary");
    expect(home).toContain("reviewProjectSummary(await host.reviewModel(project.project_id))");
    expect(home).toContain("review.unmappedCount");
    expect(home).toContain("review.scriptGapCount");
  });

  it("keeps the editor as the final authority", () => {
    expect(watch).toContain("不会修改人工决定");
    expect(inspector).toContain("EditorialDecisionPanel");
    expect(attention).toContain("最终决定后收到新意见");
  });
});
