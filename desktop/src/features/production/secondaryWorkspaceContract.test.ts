import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function path(relative: string): string {
  return fileURLToPath(new URL(relative, import.meta.url));
}

function read(relative: string): string {
  return readFileSync(path(relative), "utf8");
}

describe("project production workspace contract", () => {
  it("keeps global context in the sidebar and exactly four project workspaces in ProjectWorkbench", () => {
    const workbench = read("./ProjectWorkbench.tsx");
    const library = read("../projects/ProjectLibrary.tsx");

    expect(library).toContain("professional-global-sidebar");
    expect(library).toContain('aria-label="主导航"');
    expect(library).toContain('aria-label="系统导航"');
    expect(library).toContain("制作区在项目画布顶部切换。");
    expect(workbench).toContain("const AREAS: Record<ProductionArea, AreaDefinition>");
    for (const label of ["素材", "剧本", "时间线", "审阅"]) expect(workbench).toContain(`label: "${label}"`);
    expect(workbench).toContain('className="professional-project-toolbar"');
    expect(workbench).toContain('aria-label="制作区域"');
    expect(workbench).not.toContain("professional-secondary-nav");
    expect(workbench).not.toContain('{ page: "delivery", label: "交付" }');
    expect(workbench).not.toContain('{ page: "coverage", label: "覆盖" }');
  });

  it("does not retain CSS ownership for the retired project secondary-navigation row", () => {
    const css = read("./professional-project-workbench.css");
    expect(css).not.toContain(".professional-secondary-nav");
    expect(css).not.toContain(".professional-secondary-pages");
    expect(css).not.toContain(".professional-page-context");
  });

  it("keeps Material recovery contextual and removes retired planning workbenches", () => {
    const material = read("../material/MaterialWorkspace.tsx");
    const project = read("./ProjectWorkbench.tsx");

    expect(material).toContain('view === "repair"');
    expect(material).toContain("<MediaBindingWorkbench");
    expect(material).toContain('onClick={() => onViewChange("library")}');
    expect(project).not.toContain("CoverageWorkbench");
    expect(project).not.toContain("RoughCutWorkbench");
    expect(project).not.toContain("AssemblyWorkbench");
    expect(existsSync(path("../planning/PlanningWorkbenches.tsx"))).toBe(false);
    expect(existsSync(path("../planning/planning.css"))).toBe(false);
  });

  it("uses current workspace-owned theme layers instead of the retired material-script theme patch", () => {
    for (const relative of [
      "../material/material-workspace.css",
      "../script/script-workspace.css",
      "../review/review-workspace.css",
      "../review/review-decision.css",
      "../editor/editor-productization.css",
    ]) {
      const css = read(relative);
      expect(css, relative).toContain("var(--mo-");
      expect(css, relative).not.toContain("@media (prefers-color-scheme: light)");
      expect(css, relative).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    }
    expect(existsSync(path("./secondary-tools-theme.css"))).toBe(false);
  });

  it("keeps the official Vite-bundled logo authoritative in the sidebar", () => {
    const library = read("../projects/ProjectLibrary.tsx");
    expect(library).toContain('import mirrororderLogo from "../../assets/mirrororder-logo.svg"');
    expect(library).toContain('className="mirror-mark" src={mirrororderLogo}');
  });
});
