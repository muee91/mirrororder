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
    expect(workbench).toContain('import { MaterialWorkspace, type MaterialView } from "../material/MaterialWorkspace"');
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

  it("makes Material one workspace with internal production views and contextual repair", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const material = read("../features/material/MaterialWorkspace.tsx");
    expect(material).toContain('export type MaterialView = "slate" | "library" | "takes" | "people" | "repair"');
    expect(material).toContain('aria-label="素材视图"');
    expect(material).toContain("<GoldenSlateWorkbench");
    expect(material).toContain("<MediaLibraryWorkbench");
    expect(material).toContain("<MaterialTakeView");
    expect(material).toContain("<IdentityWorkbench");
    expect(material).toContain("<MediaBindingWorkbench");
    expect(material).toContain('onOpenMediaBinding={() => onViewChange("repair")}');
    expect(material).toContain('view === "repair"');
    expect(material).toContain('onClick={() => onViewChange("library")}');
    expect(workbench).toContain('const showSecondaryNavigation = area !== "material"');
    expect(workbench).toContain('const canvasScope = area === "material" ? "material" : page;');
    expect(workbench).not.toContain('import { IdentityWorkbench }');
    expect(workbench).not.toContain('import { MediaLibraryWorkbench }');
    expect(workbench).not.toContain('import { MediaBindingWorkbench }');
    expect(workbench).not.toContain('import { GoldenSlateWorkbench }');
  });

  it("makes Material Take browsing explain shooting facts, media health and current mapping", () => {
    const materialTake = read("../features/material/MaterialTakeView.tsx");
    expect(materialTake).toContain("production.scriptSupervisor(project.project_id)");
    expect(materialTake).toContain("slateFactIndex");
    expect(materialTake).toContain("mediaAvailabilityLabel");
    expect(materialTake).toContain("mappingLabel(take)");
    expect(materialTake).toContain('placeholder="搜索 Take、场镜次、机位、对白或备注"');
    expect(materialTake).toContain('{ value: "offline", label: "素材离线" }');
    expect(materialTake).toContain('aria-label="当前 Take 拍摄事实"');
    expect(materialTake).toContain("detailForTake");
    expect(materialTake).not.toContain("setGroupPlacement");
    expect(materialTake).not.toContain("clearGroupPlacement");
    expect(materialTake).not.toContain("showEditorial");
    expect(materialTake).not.toContain("EditorialDecisionPanel");
  });

  it("gives a Material Take explicit exits to Script, Review, Timeline and media repair", () => {
    const materialTake = read("../features/material/MaterialTakeView.tsx");
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    expect(materialTake).toContain(">在剧本中打开</button>");
    expect(materialTake).toContain(">在审阅中打开</button>");
    expect(materialTake).toContain(">到时间线</button>");
    expect(materialTake).toContain(">修复本机素材</button>");
    expect(workbench).toContain('onOpenScript={(groupId) => focusTake(groupId, "script")}');
    expect(workbench).toContain('groupId ? focusTake(groupId, "watch") : navigate("watch")');
    expect(workbench).toContain('onOpenTimeline={(groupId) => focusTake(groupId, "timeline")}');
    expect(workbench).toContain('onViewChange={(view, groupId) =>');
  });

  it("makes ScriptBlock the primary object with Script-owned placement", () => {
    const script = read("../features/script/ScriptWorkspace.tsx");
    const block = read("../features/material-script/ScriptBlock.tsx");
    const episode = read("../features/material-script/ScriptEpisodeView.tsx");
    expect(script).toContain('<main className="script-primary-canvas">');
    expect(script).toContain("connection.setGroupPlacement");
    expect(script).toContain("connection.clearGroupPlacement");
    expect(script).toContain("RoughPlacementClient");
    expect(script).toContain("placeTakeOnSelectedBlock");
    expect(script).toContain('actionLabel={mappedHere ? "查看" : "归集到此段"}');
    expect(script).toContain(">匹配素材</button>");
    expect(script).toContain(">批量归集</button>");
    expect(block).toContain('data-script-projection={projectionMode}');
    expect(block).toContain("mappedTakeIds");
    expect(block).toContain("candidateTakeIds");
    expect(episode).toContain("mappedTakeIds(model, block.segment_id)");
    expect(episode).toContain("candidateTakeIds(model, block.segment_id)");
  });

  it("folds Coverage and issue inspection into Script projections", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const script = read("../features/script/ScriptWorkspace.tsx");
    const resume = read("./resumeState.ts");
    expect(script).toContain("ScriptProjectionMode");
    expect(script).toContain('{ value: "script", label: "正文" }');
    expect(script).toContain('{ value: "coverage", label: "覆盖" }');
    expect(script).toContain('{ value: "issues", label: "问题" }');
    expect(script).toContain('aria-label="剧本显示模式"');
    expect(script).toContain('placeholder="搜索剧本、角色或场景"');
    expect(script).toContain('“覆盖”只显示已观察 placement / candidate 状态，不把无证据解释为缺镜头。');
    expect(script).not.toContain("onOpenCoverage");
    expect(workbench).not.toContain('import { CoverageWorkbench }');
    expect(workbench).not.toContain('{ page: "coverage", label: "覆盖"');
    expect(resume).toContain('if (page === "coverage") return "script";');
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
    expect(attention).toContain("export function reviewTakeAttention");
  });

  it("keeps Timeline as the product-area name and legacy edit routes collapsed into it", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const resume = read("./resumeState.ts");
    expect(workbench).toContain('type ProductionArea = "material" | "script" | "timeline" | "review"');
    expect(workbench).toContain('timeline: {\n    label: "时间线"');
    expect(workbench).toContain('{ page: "timeline", label: "时间线" }');
    expect(resume).toContain('if (page === "rough-cut" || page === "assembly") return "timeline";');
  });

  it("keeps media repair contextual instead of creating a new primary area", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const material = read("../features/material/MaterialWorkspace.tsx");
    expect(workbench).toContain('{ page: "media-binding", label: "本机素材", hidden: true }');
    expect(material).toContain('onOpenMediaBinding={() => onViewChange("repair")}');
  });

  it("keeps internal mapping ids out of the primary Script UI", () => {
    const scriptBlock = read("../features/material-script/ScriptBlock.tsx");
    const episode = read("../features/material-script/ScriptEpisodeView.tsx");
    expect(scriptBlock).not.toContain("<code>{block.segment_id}</code>");
    expect(scriptBlock).not.toContain("归集 {placementGroupId}");
    expect(scriptBlock).toContain("归集当前 Take");
    expect(episode).not.toContain("{scene.scene_id}</p>");
  });

  it("canonicalizes retired pages instead of restoring their navigation", () => {
    const resume = read("./resumeState.ts");
    expect(resume).toContain('if (page === "coverage") return "script";');
    expect(resume).toContain('if (page === "rough-cut" || page === "assembly") return "timeline";');
    expect(resume).toContain('if (page === "attention" || page === "overview") return "watch";');
  });
});
