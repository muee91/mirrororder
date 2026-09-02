import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

const FLOOR_SELECTORS = [
  ".golden-take-picker-list small",
  ".golden-slate-section > header small",
  ".golden-slate-table td.col-index small",
  ".golden-inspector-head span",
  ".golden-inspector-head em",
  ".golden-episode-candidates > header",
  ".golden-episode-candidates > button span",
  ".golden-episode-candidates > button small",
  ".golden-inspector-media > header",
  ".golden-angle-fields label",
  ".golden-io-row label",
  ".golden-inspector-field",
  ".golden-inspector-link > span",
  ".golden-inspector-link small",
];

describe("Slate production typography floor", () => {
  it("loads the professional Slate experience after the legacy fidelity layer", () => {
    const workbench = source("./GoldenSlateWorkbench.tsx");
    expect(workbench.indexOf('import "./golden-slate-media-experience.css"')).toBeGreaterThan(
      workbench.indexOf('import "./golden-slate.css"'),
    );
  });

  it("raises every remaining 9px production evidence selector to the shared 10px floor", () => {
    const legacy = source("./golden-slate.css");
    const effective = source("./golden-slate-media-experience.css");
    const design = source("../../design-system-v2.css");
    expect(legacy).not.toMatch(/font-size:\s*(?:7|8)px/);
    expect(design).toContain("--mo-font-xs: 10px");
    for (const selector of FLOOR_SELECTORS) expect(effective).toContain(selector);
    expect(effective).toContain("font-size: var(--mo-font-xs, 10px);");
    expect(effective).not.toMatch(/font-size:\s*(?:7|8|9)px/);
  });
});
