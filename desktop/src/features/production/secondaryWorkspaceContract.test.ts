import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("project secondary workspace product contract", () => {
  it("uses one compact project context bar instead of a second tab navigation system", () => {
    const workbench = read("./ProjectWorkbench.tsx");

    expect(workbench).toContain("const SECONDARY_PAGES");
    expect(workbench).toContain('aria-label="项目工具"');
    expect(workbench).toContain('className="production-secondary-switcher"');
    expect(workbench).toContain(">返回场记</button>");
    expect(workbench).not.toContain('<nav aria-label="制作辅助工作区">');
    expect(workbench).not.toContain("‹ 返回场记");
  });

  it("follows the resolved Desktop theme instead of the raw OS color scheme", () => {
    const experience = read("./product-experience.css");
    const production = read("./production.css");
    const review = read("../review/review.css");

    expect(experience).toContain('html[data-mirrororder-theme="light"] .production-secondary-workspace');
    expect(experience).toContain('html[data-mirrororder-theme="dark"] .production-secondary-workspace');
    expect(production).toContain('html[data-mirrororder-theme="light"] .identity-filter button');
    expect(production).toContain('html[data-mirrororder-theme="dark"] .identity-row');
    expect(review).toContain('html[data-mirrororder-theme="light"] .review-attention-row');
    expect(review).toContain('html[data-mirrororder-theme="dark"] .review-overview-pane');
    expect(experience).not.toContain("@media (prefers-color-scheme: light)");
    expect(production).not.toContain("@media (prefers-color-scheme: light)");
    expect(review).not.toContain("@media (prefers-color-scheme: light)");
  });

  it("presents local media recovery as an ordered flow rather than a two-card dashboard", () => {
    const workbench = read("../media/MediaBindingWorkbench.tsx");
    const css = read("../media/media.css");

    expect(workbench).toContain('className="media-binding-section media-binding-setup"');
    expect(workbench).toContain('className="media-binding-section media-binding-results"');
    expect(workbench).toContain("关于本机素材恢复");
    expect(workbench).toContain("扫描新增目录");
    expect(workbench).not.toContain("production-grid media-binding-grid");
    expect(workbench).not.toContain('className="production-panel"');
    expect(workbench).not.toContain("media-binding-counts");
    expect(css).not.toContain(".media-binding-grid");
    expect(css).not.toContain("@media (prefers-color-scheme: light)");
    expect(css).toContain('html[data-mirrororder-theme="light"] .media-binding-content');
    expect(css).toContain('html[data-mirrororder-theme="dark"] .media-binding-content');
  });

  it("keeps the official Vite-bundled logo authoritative in the sidebar", () => {
    const frozen = read("../../desktop-theme-frozen-surfaces.css");

    expect(frozen).toContain(".global-sidebar .mirror-mark");
    expect(frozen).toContain('background-image: url("./assets/mirrororder-logo.svg")');
  });
});
