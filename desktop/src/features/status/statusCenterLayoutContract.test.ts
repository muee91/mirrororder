import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("status center desktop triage contract", () => {
  it("keeps the application shell bounded instead of growing into a task log page", () => {
    const base = readFileSync(fileURLToPath(new URL("./status-center.css", import.meta.url)), "utf8");
    const redesign = readFileSync(fileURLToPath(new URL("./status-center-redesign.css", import.meta.url)), "utf8");
    expect(base).toContain("height: 100%");
    expect(base).toContain("overflow: hidden");
    expect(redesign).toContain("grid-template-rows: auto auto minmax(0, 1fr)");
    expect(redesign).toContain(".status-center-sections {");
    expect(redesign).toContain("overflow-y: auto");
    expect(redesign).toContain("scrollbar-gutter: stable");
  });

  it("uses a recovery canvas plus a dedicated live-task rail", () => {
    const redesign = readFileSync(fileURLToPath(new URL("./status-center-redesign.css", import.meta.url)), "utf8");
    expect(redesign).toContain(".status-center-section.is-attention {");
    expect(redesign).toContain("flex: 1 1 610px");
    expect(redesign).toContain(".status-center-section.is-active {");
    expect(redesign).toContain("position: sticky");
    expect(redesign).toContain("flex: 0 1 310px");
    expect(redesign).toContain("max-height: min(520px, 62vh)");
    expect(redesign).toContain(".status-center-section.is-recent {");
    expect(redesign).toContain("flex: 1 0 100%");
  });

  it("keeps current issues compact and removes stale failure progress", () => {
    const redesign = readFileSync(fileURLToPath(new URL("./status-center-redesign.css", import.meta.url)), "utf8");
    expect(redesign).toContain("max-height: min(430px, 52vh)");
    expect(redesign).toContain(".status-center-section.is-attention .status-center-progress { display: none; }");
    expect(redesign).toContain("-webkit-line-clamp: 2");
    expect(redesign).toContain("Actions: recovery first, navigation second, record cleanup tertiary");
  });

  it("makes the resolved Desktop theme the final visual authority", () => {
    const redesign = readFileSync(fileURLToPath(new URL("./status-center-redesign.css", import.meta.url)), "utf8");
    const main = readFileSync(fileURLToPath(new URL("../../main.tsx", import.meta.url)), "utf8");
    expect(redesign).toContain('html[data-mirrororder-theme="light"] .status-center-workbench');
    expect(redesign).toContain('html[data-mirrororder-theme="dark"] .status-center-workbench');
    expect(main).toContain('import "./features/status/status-center-redesign.css"');
    expect(main.indexOf('import "./features/status/status-center-redesign.css"')).toBeGreaterThan(main.indexOf('import "./features/status/status-center-recovery.css"'));
  });
});
