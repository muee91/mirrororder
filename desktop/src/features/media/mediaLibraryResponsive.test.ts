import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

describe("Media Library responsive operator workflow", () => {
  it("uses the shared operator control so Slate and Media Library stay in sync", () => {
    const workbench = source("./MediaLibraryWorkbench.tsx");
    expect(workbench).toContain("CurrentOperatorControl");
    expect(workbench).toContain("readCurrentOperator");
    expect(workbench).toContain("<CurrentOperatorControl onChange={setActor} />");
  });

  it("wraps bulk operations and gives status text a full row on narrow screens", () => {
    const styles = source("./media-library.css");
    expect(styles).toContain("flex-wrap: wrap");
    expect(styles).toContain(".media-library-bulk > span[aria-live]");
    expect(styles).toContain(".media-library-bulk { width: 100%; margin-left: 0; }");
  });
});
