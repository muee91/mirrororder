import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("MirrorOrder product surface contraction", () => {
  it("keeps Review as one production surface", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    expect(workbench).toContain('review: {\n    label: "审阅",\n    defaultPage: "watch",\n    pages: [\n      { page: "watch", label: "看片" },\n    ],');
    expect(workbench).not.toContain("ReviewAttentionWorkbench");
    expect(workbench).not.toContain("ProjectOverviewWorkbench");
  });

  it("keeps repair and diagnostic views out of primary navigation", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    expect(workbench).toContain('{ page: "media-binding", label: "本机素材", hidden: true }');
    expect(workbench).toContain('{ page: "coverage", label: "覆盖", hidden: true }');
    expect(workbench).toContain("visibleAreaPages.length > 1");
    expect(workbench).toContain("currentPageDefinition?.hidden");
  });

  it("keeps Coverage attached to Script instead of restoring a peer tab", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const materialScript = read("../features/material-script/GoldenMaterialScriptWorkbench.tsx");
    expect(workbench).toContain('onOpenCoverage={page === "script" ? () => navigate("coverage") : undefined}');
    expect(materialScript).toContain("onOpenCoverage?: () => void;");
    expect(materialScript).toContain(">覆盖视图</button>");
  });

  it("canonicalizes retired pages instead of restoring their navigation", () => {
    const resume = read("./resumeState.ts");
    expect(resume).toContain('if (page === "rough-cut" || page === "assembly") return "timeline";');
    expect(resume).toContain('if (page === "attention" || page === "overview") return "watch";');
  });
});
