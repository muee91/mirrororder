import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const FLOOR_SELECTORS = [
  ".golden-slate-section > header small",
  ".golden-slate-table td.col-index small",
  ".golden-inspector-slate-fields dt",
  ".golden-episode-candidates > header",
  ".golden-angle-fields label",
  ".golden-io-row label",
  ".golden-inspector-field",
];

describe("Slate production typography floor", () => {
  it("loads the professional Slate experience after the legacy fidelity layer", () => {
    const workbench = source("./GoldenSlateWorkbench.tsx");
    expect(workbench.indexOf('import "./golden-slate-media-experience.css"')).toBeGreaterThan(
      workbench.indexOf('import "./golden-slate.css"'),
    );
  });

  it("raises Slate and compact Take evidence to the shared 11px floor", () => {
    const legacy = source("./golden-slate.css");
    const effective = source("./golden-slate-media-experience.css");
    const takeCard = source("../material-script/take-card.css");
    const design = source("../../design-system-v2.css");
    expect(legacy).not.toMatch(/font-size:\s*(?:7|8)px/);
    expect(design).toContain("--mo-font-xs: 11px");
    for (const selector of FLOOR_SELECTORS) expect(effective).toContain(selector);
    expect(effective).toContain("font-size: var(--mo-font-xs, 10px);");
    expect(effective).not.toMatch(/font-size:\s*(?:7|8|9)px/);
    expect(takeCard).toContain("font-size: var(--mo-font-xs, 10px);");
    expect(takeCard).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });
});
