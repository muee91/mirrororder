import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("status center desktop operations contract", () => {
  it("keeps the application shell bounded instead of growing into a task log page", () => {
    const css = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    expect(css).toContain("height: 100%");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
    expect(css).toContain(".status-center-sections {");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("scrollbar-gutter: stable");
  });

  it("uses current-issue, live-work and history regions without freezing obsolete rail geometry", () => {
    const css = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    expect(css).toContain(".status-center-section.is-attention { order: 0; flex: 1 1 610px; }");
    expect(css).toContain(".status-center-section.is-active {");
    expect(css).toContain("position: sticky");
    expect(css).toContain("flex: 0 1 320px");
    expect(css).toContain(".status-center-section.is-recent { order: 2; flex: 1 0 100%; }");
    expect(css).not.toContain("flex: 0 1 310px");
  });

  it("keeps terminal failures compact and removes stale failure progress", () => {
    const css = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    expect(css).toContain("max-height: min(430px, 52vh)");
    expect(css).toContain(".status-center-section.is-attention .status-center-progress { display: none; }");
    expect(css).toContain("-webkit-line-clamp: 2");
  });

  it("renders durable task state through the shared TaskStatusIndicator family", () => {
    const source = readFileSync(fileURLToPath(new URL("./StatusCenterWorkbench.tsx", import.meta.url)), "utf8");
    const adoption = readFileSync(fileURLToPath(new URL("./status-center-task-status.css", import.meta.url)), "utf8");
    expect(source).toContain('TaskStatusIndicator, type TaskIndicatorState');
    expect(source).toContain("export function taskIndicatorState(");
    expect(source).toContain("<TaskStatusIndicator");
    expect(source).toContain("progress={indicatorProgress}");
    expect(source).toContain("taskProgress && active(task)");
    expect(source).not.toContain('<span className="status-center-task-indicator"');
    expect(adoption).toContain(".status-center-task-main .mo-task-status-indicator");
    expect(adoption).toContain("status-center-progress-count-only");
    expect(adoption).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });

  it("consumes the shared MirrorOrder semantic system instead of maintaining a second theme", () => {
    const css = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    const main = readFileSync(fileURLToPath(new URL("../../main.tsx", import.meta.url)), "utf8");
    expect(css).toContain("var(--mo-surface-app");
    expect(css).toContain("var(--mo-text-primary");
    expect(css).toContain("var(--mo-accent");
    expect(css).toContain("var(--mo-warning");
    expect(css).not.toContain("--sc-");
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    expect(main).not.toContain("status-center-redesign.css");
    expect(main).not.toContain("status-center-recovery.css");
  });
});
