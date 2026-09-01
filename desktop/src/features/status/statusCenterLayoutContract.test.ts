import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("status center bounded workspace contract", () => {
  it("keeps the application shell bounded instead of growing into a task log page", () => {
    const css = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    expect(css).toContain("grid-template-rows: auto auto auto minmax(0, 1fr)");
    expect(css).toContain("height: 100%");
    expect(css).toContain("overflow: hidden");
    expect(css).toContain(".status-center-sections {");
    expect(css).toContain("min-height: 0");
    expect(css).toContain("overflow-y: auto");
    expect(css).toContain("scrollbar-gutter: stable");
  });

  it("keeps live cancellation pinned above a large recovery backlog", () => {
    const recovery = readFileSync(fileURLToPath(new URL("./status-center-recovery.css", import.meta.url)), "utf8");
    expect(recovery).toContain(".status-center-section.is-active {");
    expect(recovery).toContain("position: sticky");
    expect(recovery).toContain("order: -20");
    expect(recovery).toContain("max-height: min(250px, 30vh)");
    expect(recovery).toContain(".status-center-section.is-attention { order: -10; }");
  });

  it("does not present stale failure progress as if failed work were still running", () => {
    const css = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    expect(css).toContain(".status-center-section.is-attention .status-center-task.status-failed .status-center-progress");
    expect(css).toContain(".status-center-section.is-attention .status-center-task.status-interrupted .status-center-progress");
    expect(css).toContain("display: none");
    expect(css).toContain("-webkit-line-clamp: 2");
  });
});
