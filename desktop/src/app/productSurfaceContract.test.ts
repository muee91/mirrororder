import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function path(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(path(relative), "utf8");
}

describe("MirrorOrder product surface contraction", () => {
  it("keeps four independent production workspaces instead of a cross-domain switch", () => {
    const workbench = read("../features/production/ProjectWorkbench.tsx");
    const navigation = read("../features/production/productionNavigation.ts");
    expect(navigation).toContain('export type ProductionWorkspace = "material" | "script" | "timeline" | "review"');
    for (const component of ["MaterialWorkspace", "ScriptWorkspace", "TimelineWorkbench", "ReviewWorkspace"]) {
      expect(workbench).toContain(`<${component}`);
    }
    expect(workbench).not.toContain("MaterialScriptWorkbench");
    expect(existsSync(path("../features/material-script/MaterialScriptWorkbench.tsx"))).toBe(false);
  });

  it("makes Material one workspace with internal production views and contextual repair", () => {
    const material = read("../features/material/MaterialWorkspace.tsx");
    const take = read("../features/material/MaterialTakeView.tsx");
    expect(material).toContain('export type MaterialView = "slate" | "library" | "takes" | "people" | "repair"');
    expect(material).toContain('aria-label="素材视图"');
    for (const child of ["GoldenSlateWorkbench", "MediaLibraryWorkbench", "MaterialTakeView", "IdentityWorkbench", "MediaBindingWorkbench"]) {
      expect(material).toContain(child);
    }
    expect(take).toContain("production.scriptSupervisor(project.project_id)");
    expect(take).toContain('placeholder="搜索 Take、场镜次、机位、对白或备注"');
    expect(take).toContain(">在剧本中打开</button>");
    expect(take).toContain(">在审阅中打开</button>");
    expect(take).toContain(">到时间线</button>");
    expect(take).not.toContain("setGroupPlacement");
  });

  it("makes ScriptBlock the primary object and keeps placement writes in Script", () => {
    const script = read("../features/script/ScriptWorkspace.tsx");
    const block = read("../features/material-script/ScriptBlock.tsx");
    const resume = read("./resumeState.ts");
    expect(script).toContain('<main className="script-primary-canvas">');
    expect(script).toContain("connection.setGroupPlacement");
    expect(script).toContain("connection.clearGroupPlacement");
    expect(script).toContain("placeTakeOnSelectedBlock");
    expect(script).toContain('{ value: "coverage", label: "覆盖" }');
    expect(script).toContain('{ value: "issues", label: "问题" }');
    expect(block).toContain('data-script-projection={projectionMode}');
    expect(resume).toContain('if (page === "coverage") return "script";');
    expect(existsSync(path("../features/planning/PlanningWorkbenches.tsx"))).toBe(false);
  });

  it("keeps Review viewer-first and owns only Take-level Final Editorial Decision", () => {
    const review = read("../features/review/ReviewWorkspace.tsx");
    const decision = read("../features/review/ReviewDecisionPanel.tsx");
    const inspector = read("../features/material-script/TakeInspector.tsx");
    expect(review).toContain('{ value: "unreviewed", label: "未决定" }');
    expect(review).toContain('{ value: "attention", label: "需关注" }');
    expect(review).toContain("<ReviewDecisionPanel");
    expect(review).toContain('aria-label="看片与人工决定"');
    expect(decision).toContain('targetKind: "group"');
    expect(decision).not.toContain('decide("assignment"');
    expect(inspector).not.toContain("showEditorial");
    expect(inspector).not.toContain("EditorialDecisionPanel");
    expect(review).not.toContain("setGroupPlacement");
  });

  it("keeps Timeline as the only editor and Delivery as its contextual flow", () => {
    const project = read("../features/production/ProjectWorkbench.tsx");
    const timeline = read("../features/editor/TimelineWorkbench.tsx");
    const resume = read("./resumeState.ts");
    expect(project).toContain('timeline: {\n    label: "时间线"');
    expect(project).not.toContain('{ page: "delivery", label: "交付" }');
    expect(timeline).toContain("<DeliveryWorkbench");
    expect(timeline).toContain("useTimelineAuthorityActions");
    expect(resume).toContain('page === "rough-cut" || page === "assembly" || page === "delivery"');
  });

  it("uses one typed selection/navigation context across workspaces", () => {
    const navigation = read("../features/production/productionNavigation.ts");
    const project = read("../features/production/ProjectWorkbench.tsx");
    expect(navigation).toContain("export interface ProductionSelectionContext");
    expect(navigation).toContain("export interface ProductionNavigationIntent extends ProductionSelectionContext");
    expect(project).toContain("const [selection, setSelection] = useState<ProductionSelectionContext>");
    expect(project).toContain("initialScriptSegmentId={currentSelection.scriptSegmentId ?? null}");
    expect(project).not.toContain("ReviewReturnContext");
  });

  it("removes ownerless recovery-era workbenches and workflow CSS", () => {
    for (const relative of [
      "../features/material-script/TakeEvidencePanels.tsx",
      "../features/material-script/editorial-inspector.css",
      "../features/planning/PlanningWorkbenches.tsx",
      "../features/planning/planning.css",
      "../features/production/secondary-tools-theme.css",
    ]) {
      expect(existsSync(path(relative)), relative).toBe(false);
    }
  });
});
