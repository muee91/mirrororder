import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("MirrorOrder Design System v2 contract", () => {
  it("loads the v2 layer after legacy theme and workspace overrides", () => {
    const main = read("../main.tsx");
    const redesignIndex = main.indexOf('import "./app/project-context-redesign.css";');
    const v2Index = main.indexOf('import "./design-system-v2.css";');

    expect(v2Index).toBeGreaterThan(redesignIndex);
  });

  it("defines semantic production tokens instead of another page-specific palette", () => {
    const css = read("../design-system-v2.css");

    expect(css).toContain("--mo-surface-app:");
    expect(css).toContain("--mo-surface-pane:");
    expect(css).toContain("--mo-border-default:");
    expect(css).toContain("--mo-text-primary:");
    expect(css).toContain("--mo-accent:");
    expect(css).toContain("--mo-success:");
    expect(css).toContain("--mo-warning:");
    expect(css).toContain("--mo-danger:");
  });

  it("restores a visible keyboard focus grammar", () => {
    const base = read("../styles.css");
    const css = read("../design-system-v2.css");

    expect(base).toContain("input, textarea, select { outline: none; }");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("outline: 1px solid var(--mo-accent)");
    expect(css).toContain("--mo-focus-ring:");
  });

  it("keeps the slate as a ledger and raises tiny utility copy to a legible floor", () => {
    const css = read("../design-system-v2.css");

    expect(css).toContain(".golden-slate-table { font-size: var(--mo-font-sm); }");
    expect(css).toContain(".golden-slate-table tr.is-selected td:first-child");
    expect(css).toContain(".workspace-control-actions button");
    expect(css).toContain("font-size: var(--mo-font-xs)");
  });
});
