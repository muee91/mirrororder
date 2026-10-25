import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("MirrorOrder Design System v2 contract", () => {
  it("loads the v2 layer after legacy theme and workspace overrides", () => {
    const main = read("../main.tsx");
    const redesignIndex = main.indexOf('import "./app/mirrororder-workspaces-redesign.css";');
    const chromeIndex = main.indexOf('import "./app/app-chrome.css";');
    const v2Index = main.indexOf('import "./design-system-v2.css";');

    expect(redesignIndex).toBeGreaterThan(-1);
    expect(chromeIndex).toBeGreaterThan(redesignIndex);
    expect(v2Index).toBeGreaterThan(chromeIndex);
  });

  it("resolves every global stylesheet imported by the app entry and the dev fixtures", () => {
    // A layer was deleted while two dev fixtures still imported it, and no gate
    // noticed: typecheck, vitest and `vite build` never compile scripts/fixtures.
    // The ux-real evidence harness had therefore been broken for weeks.
    const entrypoints = [
      "../main.tsx",
      "../../scripts/fixtures/ux-real.tsx",
      "../../scripts/fixtures/ux-audit.tsx",
      "../../scripts/fixtures/project-workbench-layout.tsx",
    ];
    const dangling: string[] = [];
    const missing: string[] = [];
    for (const entry of entrypoints) {
      const entryPath = fileURLToPath(new URL(entry, import.meta.url));
      if (!existsSync(entryPath)) {
        // Silently skipping an entrypoint would turn this guard into a gate that
        // can never go red, which is the exact failure mode being guarded against.
        missing.push(entry);
        continue;
      }
      const source = readFileSync(entryPath, "utf8");
      for (const match of source.matchAll(/import\s+"([^"]+\.css)"/g)) {
        if (!existsSync(resolve(dirname(entryPath), match[1]!))) dangling.push(`${entry} → ${match[1]}`);
      }
    }
    expect({ missing, dangling }).toEqual({ missing: [], dangling: [] });
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

  it("keeps project chrome compact and aligned with the current toolbar-plus-canvas authority", () => {
    const project = read("../features/production/professional-project-workbench.css");

    expect(project).toContain("grid-template-rows: 48px minmax(0, 1fr)");
    expect(project).not.toContain("grid-template-rows: 48px 32px");
    expect(project).toContain(".professional-area-nav button.is-active:hover");
    expect(project).not.toContain(".professional-secondary-pages");
    // The dead second context-bar layer is gone; ProjectWorkbench keeps the only chrome authority.
    expect(existsSync(fileURLToPath(new URL("./project-context-redesign.css", import.meta.url)))).toBe(false);
  });

  it("keeps global chrome quiet, compact and row-oriented", () => {
    const chrome = read("./app-chrome.css");

    expect(chrome).toContain("grid-template-columns: 224px minmax(0, 1fr)");
    expect(chrome).toContain("grid-template-rows: 46px minmax(0, 1fr)");
    expect(chrome).toContain(".project-current-card.is-active-context:hover");
    expect(chrome).toContain("box-shadow: inset 2px 0 0 var(--mo-accent");
    expect(chrome).toContain(".app-global-actions button");
    expect(chrome).toContain("border: 0");
    expect(chrome).toContain(".professional-project-context-note");
    expect(chrome).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });
});
