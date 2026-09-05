import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("single Timeline authority", () => {
  it("shows Timeline as the only editor workspace", () => {
    const project = read("./ProjectWorkbench.tsx");
    const timeline = read("../editor/TimelineWorkbench.tsx");

    expect(project).toContain('timeline: {\n    label: "时间线"');
    expect(project).toContain('{ page: "timeline", label: "时间线" }');
    expect(project).not.toContain('{ page: "rough-cut", label: "粗剪" }');
    expect(project).not.toContain('{ page: "assembly", label: "组接" }');
    expect(project).not.toContain("<RoughCutWorkbench");
    expect(project).not.toContain("<AssemblyWorkbench");
    expect(timeline).toContain("useTimelineAuthorityActions");
  });

  it("keeps Delivery as a contextual Timeline flow instead of a peer page", () => {
    const project = read("./ProjectWorkbench.tsx");
    const timeline = read("../editor/TimelineWorkbench.tsx");
    const resume = read("../../app/resumeState.ts");

    expect(project).not.toContain('{ page: "delivery", label: "交付" }');
    expect(timeline).toContain("<DeliveryWorkbench");
    expect(timeline).toContain('aria-label="时间线交付"');
    expect(resume).toContain('page === "rough-cut" || page === "assembly" || page === "delivery"');
    expect(resume).toContain('return "timeline"');
  });
});
