import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Media Library responsive operator workflow", () => {
  it("reads the shared operator state without mounting a second editor", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("readCurrentOperator");
    expect(workbench).toContain('mirrororder:operator-change');
    expect(workbench).not.toContain("<CurrentOperatorControl");
  });

  it("wraps bulk operations and gives status text a full row on narrow screens", () => {
    const styles = source("./media-library.css");
    expect(styles).toContain("flex-wrap: wrap");
    expect(styles).toContain(".media-library-bulk > span[aria-live]");
    expect(styles).toContain(".media-library-bulk { width: 100%; margin-left: 0; }");
  });
});
