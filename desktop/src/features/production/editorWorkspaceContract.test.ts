import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("single editorial workbench", () => {
  it("shows one editor workspace instead of separate rough-cut/assembly/timeline pages", () => {
    const source = read("./ProjectWorkbench.tsx");
    expect(source).toContain('{ page: "timeline", label: "剪辑工作台" }');
    expect(source).not.toContain('{ page: "rough-cut", label: "粗剪" }');
    expect(source).not.toContain('{ page: "assembly", label: "组接" }');
    expect(source).not.toContain("<RoughCutWorkbench");
    expect(source).not.toContain("<AssemblyWorkbench");
  });

  it("keeps delivery as an action surface beside the authoritative editor", () => {
    const source = read("./ProjectWorkbench.tsx");
    expect(source).toContain('{ page: "delivery", label: "交付" }');
    expect(source).toContain('<TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} />');
  });
});
