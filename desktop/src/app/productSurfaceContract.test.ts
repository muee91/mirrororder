import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

function exists(relative: string): boolean {
  return existsSync(fileURLToPath(new URL(relative, import.meta.url)));
}

describe("MirrorOrder product surface contraction", () => {
  it("keeps four independent production workspaces instead of a cross-domain surface switch", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    expect(workbench).toContain('import { MaterialWorkspace } from "../material/MaterialWorkspace"');
    expect(workbench).toContain('import { ScriptWorkspace } from "../script/ScriptWorkspace"');
    expect(workbench).toContain('import { ReviewWorkspace } from "../review/ReviewWorkspace"');
    expect(workbench).toContain("<MaterialWorkspace");
    expect(workbench).toContain("<ScriptWorkspace");
    expect(workbench).toContain("<TimelineWorkbench");
    expect(workbench).toContain("<ReviewWorkspace");
    expect(workbench).not.toContain("MaterialScriptWorkbench");
    expect(workbench).not.toContain('surface="takes"');
    expect(workbench).not.toContain('surface="script"');
    expect(workbench).not.toContain('surface="review"');
    expect(exists("../features/material-script/MaterialScriptWorkbench.tsx")).toBe(false);
  });

  it("keeps Material focused on Take and production facts without owning placement or editorial decisions", () => {
    const material = read("../features/material/MaterialWorkspace.tsx");
    expect(material).toContain('<main className="material-primary-canvas">');
    expect(material).toContain("<VirtualTakeList");
    expect(material).toContain("<TakeInspector");
    expect(material).toContain("onOpenScript");
    expect(material).not.toContain("setGroupPlacement");
    expect(material).not.toContain("clearGroupPlacement");
    expect(material).not.toContain("RoughPlacementClient");
    expect(material).not.toContain("showEditorial");
    expect(material).not.toContain("review-actor-field");
  });

  it("makes Script the only production workspace that writes Review placement", () => {
    const script = read("../features/script/ScriptWorkspace.tsx");
    expect(script).toContain('<main className="script-primary-canvas">');
    expect(script).toContain("connection.setGroupPlacement");
    expect(script).toContain("connection.clearGroupPlacement");
    expect(script).toContain("RoughPlacementClient");
    expect(script).toContain("script-candidate-browser");
    expect(script).toContain("TakeListRow");
    expect(script).toContain(">批量归集</button>");
    expect(script).toContain("onOpenCoverage");
  });

  it("keeps Review viewer-first with attention as a filter and editorial decisions in the viewer", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const review = read("../features/review/ReviewWorkspace.tsx");
    const attention = read("../features/review/reviewAttention.ts");
    expect(workbench).toContain('review: {\n    label: "审阅",\n    defaultPage: "watch",\n    pages: [\n      { page: "watch", label: "看片" },\n    ],');
    expect(review).toContain('{ value: "attention", label: "需关注" }');
    expect(review).toContain('<main className="review-primary-canvas">');
    expect(review).toContain('aria-label="看片与人工决定"');
    expect(review).toContain("showEditorial");
    expect(review).toContain("reviewTakeAttention(take).hasAttention");
    expect(review).not.toContain("setGroupPlacement");
    expect(review).not.toContain("clearGroupPlacement");
    expect(review).not.toContain("review-actor-field");
    expect(attention).toContain("export function reviewTakeAttention");
  });

  it("routes evidence actions to the workspace that owns the work", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    expect(workbench).toContain('onOpenTake={(groupId) => focusTake(groupId, "takes")}');
    expect(workbench).toContain('onOpenTake={(groupId) => focusTake(groupId, "script")}');
    expect(workbench).toContain('onOpenScript={(groupId) => focusTake(groupId, "script")}');
    expect(workbench).not.toContain("ReviewReturnContext");
    expect(workbench).not.toContain("reviewReturn");
  });

  it("keeps Timeline as the product-area name and legacy edit routes collapsed into it", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const resume = read("./resumeState.ts");
    expect(workbench).toContain('type ProductionArea = "material" | "script" | "timeline" | "review"');
    expect(workbench).toContain('timeline: {\n    label: "时间线"');
    expect(workbench).toContain('{ page: "timeline", label: "时间线" }');
    expect(resume).toContain('if (page === "rough-cut" || page === "assembly") return "timeline";');
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

  it("keeps repair and Coverage views contextual instead of primary navigation", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    expect(workbench).toContain('{ page: "media-binding", label: "本机素材", hidden: true }');
    expect(workbench).toContain('{ page: "coverage", label: "覆盖", hidden: true }');
    expect(workbench).toContain("visibleAreaPages.length > 1");
    expect(workbench).toContain("currentPageDefinition?.hidden");
    expect(workbench).toContain('onOpenCoverage={() => navigate("coverage")}');
  });

  it("canonicalizes retired pages instead of restoring their navigation", () => {
    const resume = read("./resumeState.ts");
    expect(resume).toContain('if (page === "rough-cut" || page === "assembly") return "timeline";');
    expect(resume).toContain('if (page === "attention" || page === "overview") return "watch";');
  });
});
