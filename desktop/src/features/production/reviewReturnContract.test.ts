import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("review return flow", () => {
  it("keeps the source workspace reachable while a Take is opened for review", () => {
    const workbench = read("./ProjectWorkbench.tsx");

    expect(workbench).toContain("interface ReviewReturnContext");
    expect(workbench).toContain("const sourcePage = page;");
    expect(workbench).toContain('navigate("watch", { preserveReviewReturn: true });');
    expect(workbench).toContain('page === "watch" && reviewReturn');
    expect(workbench).toContain("← {reviewReturn.label}");
    expect(workbench).toContain("navigate(reviewReturn.page);");
  });

  it("clears stale return context during ordinary navigation", () => {
    const workbench = read("./ProjectWorkbench.tsx");

    expect(workbench).toContain("if (!options?.preserveReviewReturn) setReviewReturn(null);");
    expect(workbench).toContain('setReviewReturn(sourcePage === "watch" ? null : { page: sourcePage, label: pageLabel(sourcePage) });');
  });
});
