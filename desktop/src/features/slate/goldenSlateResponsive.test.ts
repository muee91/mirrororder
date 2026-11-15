import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Golden Slate responsive inspector", () => {
  it("collapses the inspector below the table on narrow screens", () => {
    const styles = source("./golden-slate.css");
    expect(styles).toContain("@media (max-width: 900px)");
    expect(styles).toContain("grid-template-columns: minmax(0, 1fr)");
    expect(styles).toContain("border-left: 0");
  });
});
