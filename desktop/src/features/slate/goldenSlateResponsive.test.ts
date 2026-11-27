import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Golden Slate responsive inspector", () => {
  it("keeps the table width and docks the inspector over its right edge on narrow screens", () => {
    const styles = source("./golden-slate.css");
    const narrow = styles.slice(styles.indexOf("@media (max-width: 1160px)"));
    expect(narrow).toContain(".golden-slate-table-shell { isolation: isolate; }");
    expect(narrow).toContain(".golden-slate-body { grid-template-columns: minmax(0, 1fr) 36px; }");
    expect(narrow).toMatch(/\.golden-slate-inspector \{[^}]*position: absolute;[^}]*inset-inline-end: 0;/);
  });
});
