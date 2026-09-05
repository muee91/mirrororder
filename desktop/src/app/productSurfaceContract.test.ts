import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("MirrorOrder product surface contraction", () => {
  it("keeps Review as one production surface with attention as a watch filter", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const watch = read("../features/material-script/MaterialScriptWorkbench.tsx");
    const attention = read("../features/review/reviewAttention.ts");
    expect(workbench).toContain('review: {\n    label: "审阅",\n    defaultPage: "watch",\n    pages: [\n      { page: "watch", label: "看片" },\n    ],');
    expect(workbench).not.toContain("ReviewAttentionWorkbench");
    expect(workbench).not.toContain("ProjectOverviewWorkbench");
    expect(watch).toContain('{ value: "attention", label: "需关注" }');
    expect(watch).toContain("reviewTakeAttention(take).hasAttention");
    expect(attention).toContain("export function reviewTakeAttention");
  });

  it("uses one role-based MaterialScript surface instead of parallel workbenches", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const materialScript = read("../features/material-script/MaterialScriptWorkbench.tsx");
    expect(workbench).not.toContain("GoldenMaterialScriptWorkbench");
    expect(workbench).toContain('surface="takes"');
    expect(workbench).toContain('surface="script"');
    expect(workbench).toContain('surface="review"');
    expect(materialScript).toContain('export type MaterialScriptSurface = "takes" | "script" | "review";');
    expect(materialScript).not.toContain("WorkbenchTab");
    expect(materialScript).not.toContain('aria-label="素材剧本工作台"');
    expect(materialScript).toContain("material-script-context-drawer");
    expect(materialScript).toContain('variant="compact"');
  });

  it("keeps batch rough placement as a contextual Take tool instead of a parallel workbench", () => {
    const materialScript = read("../features/material-script/MaterialScriptWorkbench.tsx");
    expect(materialScript).toContain("RoughPlacementClient");
    expect(materialScript).toContain(">批量归集</button>");
    expect(materialScript).toContain("previewRoughPlacement");
    expect(materialScript).toContain("applyRoughPlacement");
  });

  it("keeps Script as the primary canvas and moves Take matching into context", () => {
    const materialScript = read("../features/material-script/MaterialScriptWorkbench.tsx");
    const surfaceCss = read("../features/material-script/material-script-workbench.css");
    expect(materialScript).toContain('surface === "script"');
    expect(materialScript).toContain('<main className="script-primary-canvas">');
    expect(materialScript).toContain("script-candidate-browser");
    expect(materialScript).toContain("TakeListRow");
    expect(surfaceCss).toContain(".material-script-context-drawer");
    expect(surfaceCss).toContain(".script-primary-canvas");
  });

  it("keeps internal mapping ids out of the primary Script UI", () => {
    const scriptBlock = read("../features/material-script/ScriptBlock.tsx");
    const episode = read("../features/material-script/ScriptEpisodeView.tsx");
    expect(scriptBlock).not.toContain("<code>{block.segment_id}</code>");
    expect(scriptBlock).not.toContain("归集 {placementGroupId}");
    expect(scriptBlock).toContain("归集当前 Take");
    expect(episode).not.toContain("{scene.scene_id}</p>");
  });

  it("moves useful project overview signals into Project Home", () => {
    const home = read("../features/projects/ProjectHome.tsx");
    const presentation = read("../features/projects/projectPresentation.ts");
    expect(home).toContain("reviewProjectSummary(await host.reviewModel(project.project_id))");
    expect(home).toContain("review.unmappedCount");
    expect(home).toContain("review.scriptGapCount");
    expect(presentation).toContain("review?.attentionCount");
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
    const materialScript = read("../features/material-script/MaterialScriptWorkbench.tsx");
    expect(workbench).toContain('surface="script"');
    expect(workbench).toContain('onOpenCoverage={() => navigate("coverage")}');
    expect(materialScript).toContain("onOpenCoverage?: () => void;");
    expect(materialScript).toContain(">覆盖</button>");
  });

  it("canonicalizes retired pages instead of restoring their navigation", () => {
    const resume = read("./resumeState.ts");
    expect(resume).toContain('if (page === "rough-cut" || page === "assembly") return "timeline";');
    expect(resume).toContain('if (page === "attention" || page === "overview") return "watch";');
  });
});
