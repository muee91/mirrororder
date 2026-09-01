import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("project secondary workspace product contract", () => {
  it("keeps project-level navigation authoritative in the sidebar and secondary headers contextual", () => {
    const workbench = read("./ProjectWorkbench.tsx");
    const library = read("../projects/ProjectLibrary.tsx");
    const contextCss = read("../../app/project-context-redesign.css");

    expect(library).toContain('aria-label="当前项目制作导航"');
    expect(library).toContain('onClick={() => openPage("watch")}');
    expect(library).toContain(">团队审阅</button>");
    expect(workbench).toContain("const SECONDARY_PAGE_LABELS");
    expect(workbench).toContain('className="production-secondary-back"');
    expect(workbench).toContain('aria-label="返回场记"');
    expect(workbench).toContain('onClick={() => navigate("slate")}');
    expect(workbench).toContain('className="project-workbench-main owns-chrome"');
    expect(workbench).not.toContain('aria-label="项目工具"');
    expect(workbench).not.toContain('className="production-secondary-tabs"');
    expect(workbench).not.toContain("const SECONDARY_PAGES");
    expect(contextCss).toContain("grid-template-rows: 42px minmax(0, 1fr)");
    expect(contextCss).toContain("grid-template-columns: auto minmax(0, 1fr) auto");
    expect(contextCss).not.toContain("production-secondary-tabs");
  });

  it("follows the resolved Desktop theme instead of the raw OS color scheme", () => {
    const workbench = read("./ProjectWorkbench.tsx");
    const experience = read("./product-experience.css");
    const production = read("./production.css");
    const review = read("../review/review.css");
    const mediaLibrary = read("../media/media-library.css");
    const secondaryTheme = read("./secondary-tools-theme.css");

    expect(experience).toContain('html[data-mirrororder-theme="light"] .production-secondary-workspace');
    expect(experience).toContain('html[data-mirrororder-theme="dark"] .production-secondary-workspace');
    expect(production).toContain('html[data-mirrororder-theme="light"] .identity-filter button');
    expect(production).toContain('html[data-mirrororder-theme="dark"] .identity-row');
    expect(review).toContain('html[data-mirrororder-theme="light"] .review-attention-row');
    expect(review).toContain('html[data-mirrororder-theme="dark"] .review-overview-pane');
    expect(mediaLibrary).toContain('html[data-mirrororder-theme="light"] .media-library-list');
    expect(mediaLibrary).toContain('html[data-mirrororder-theme="dark"] .media-library-list');
    expect(secondaryTheme).toContain('html[data-mirrororder-theme="light"] .material-script-workbench .take-card');
    expect(secondaryTheme).toContain('html[data-mirrororder-theme="dark"] .material-script-workbench .take-card');
    expect(workbench.indexOf('import "../material-script/material-script.css"')).toBeLessThan(workbench.indexOf('import "./secondary-tools-theme.css"'));
    expect(experience).not.toContain("@media (prefers-color-scheme: light)");
    expect(production).not.toContain("@media (prefers-color-scheme: light)");
    expect(review).not.toContain("@media (prefers-color-scheme: light)");
    expect(mediaLibrary).not.toContain("@media (prefers-color-scheme: light)");
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

  it("routes media recovery as a sibling project tool instead of nesting a workbench inside the media library", () => {
    const projectWorkbench = read("./ProjectWorkbench.tsx");
    const mediaLibrary = read("../media/MediaLibraryWorkbench.tsx");

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
