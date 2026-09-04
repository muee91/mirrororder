import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("project production workspace product contract", () => {
  it("keeps global context in the sidebar and project navigation in the Production toolbar", () => {
    const workbench = read("./ProjectWorkbench.tsx");
    const library = read("../projects/ProjectLibrary.tsx");

    expect(library).toContain("professional-global-sidebar");
    expect(library).toContain('aria-label="主导航"');
    expect(library).toContain('aria-label="系统导航"');
    expect(library).toContain("制作区在项目画布顶部切换。");
    expect(library).not.toContain('aria-label="当前项目制作导航"');
    expect(library).not.toContain('openPage("watch")');

    expect(workbench).toContain("const AREAS: Record<ProductionArea, AreaDefinition>");
    expect(workbench).toContain('label: "素材"');
    expect(workbench).toContain('label: "剧本"');
    expect(workbench).toContain('label: "剪辑"');
    expect(workbench).toContain('label: "审阅"');
    expect(workbench).toContain('className="professional-project-toolbar"');
    expect(workbench).toContain('aria-label="制作区域"');
    expect(workbench).toContain('className="professional-secondary-nav"');
    expect(workbench).toContain('areaDefinition.pages.filter((item) => item.page !== "media-binding")');

    const editArea = workbench.slice(workbench.indexOf("edit: {"), workbench.indexOf("review: {"));
    expect(editArea).toContain('{ page: "timeline", label: "剪辑工作台" }');
    expect(editArea).toContain('{ page: "delivery", label: "交付" }');
    expect(editArea).not.toContain('{ page: "rough-cut"');
    expect(editArea).not.toContain('{ page: "assembly"');
  });

  it("uses shared semantic tokens and resolved Desktop theme authority", () => {
    const experience = read("./product-experience.css");
    const production = read("./production.css");
    const review = read("../review/review.css");
    const mediaLibrary = read("../media/media-library.css");
    const planning = read("../planning/planning.css");
    const timeline = read("../editor/timeline.css");
    const secondaryTheme = read("./secondary-tools-theme.css");

    for (const [name, css] of [["production", production], ["media", mediaLibrary], ["planning", planning], ["timeline", timeline]] as const) {
      expect(css, name).toContain("var(--mo-");
      expect(css, name).not.toContain("@media (prefers-color-scheme: light)");
      expect(css, name).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    }
    expect(experience).not.toContain("@media (prefers-color-scheme: light)");
    expect(review).not.toContain("@media (prefers-color-scheme: light)");
    expect(secondaryTheme).toContain('html[data-mirrororder-theme="light"] .material-script-workbench .take-card');
    expect(secondaryTheme).toContain('html[data-mirrororder-theme="dark"] .material-script-workbench .take-card');
  });

  it("presents local media recovery as an ordered reconnect flow rather than a two-card dashboard", () => {
    const workbench = read("../media/MediaBindingWorkbench.tsx");
    const css = read("../media/media.css");

    expect(workbench).toContain('className="media-binding-section media-binding-setup"');
    expect(workbench).toContain('className="media-binding-section media-binding-results"');
    expect(workbench).toContain("重连规则");
    expect(workbench).toContain("重新连接已移动素材…");
    expect(workbench).toContain("添加搜索位置…");
    expect(workbench).not.toContain("扫描新增目录");
    expect(workbench).not.toContain("替换目录并重扫");
    expect(workbench).not.toContain("production-grid media-binding-grid");
    expect(workbench).not.toContain('className="production-panel"');
    expect(workbench).not.toContain("media-binding-counts");
    expect(css).not.toContain(".media-binding-grid");
    expect(css).not.toContain("@media (prefers-color-scheme: light)");
    expect(css).toContain('html[data-mirrororder-theme="light"] .media-binding-content');
    expect(css).toContain('html[data-mirrororder-theme="dark"] .media-binding-content');
  });

  it("routes media recovery as a hidden utility page instead of a Production navigation tab", () => {
    const projectWorkbench = read("./ProjectWorkbench.tsx");
    const mediaLibrary = read("../media/MediaLibraryWorkbench.tsx");

    expect(projectWorkbench).toContain('{ page: "media-binding", label: "本机素材" }');
    expect(projectWorkbench).toContain('areaDefinition.pages.filter((item) => item.page !== "media-binding")');
    expect(projectWorkbench).toContain('onOpenMediaBinding={() => navigate("media-binding")}');
    expect(mediaLibrary).toContain("onOpenMediaBinding?: () => void");
    expect(mediaLibrary).not.toContain('import { MediaBindingWorkbench }');
    expect(mediaLibrary).not.toContain("<MediaBindingWorkbench");
    expect(mediaLibrary).not.toContain("showBinding");
  });

  it("keeps the official Vite-bundled logo authoritative in the sidebar", () => {
    const library = read("../projects/ProjectLibrary.tsx");
    expect(library).toContain('import mirrororderLogo from "../../assets/mirrororder-logo.svg"');
    expect(library).toContain('className="mirror-mark" src={mirrororderLogo}');
  });
});
