import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Take reviewing ergonomics", () => {
  it("keeps the viewer ahead of secondary evidence in the Inspector", () => {
    const inspector = read("./TakeInspector.tsx");
    const css = read("./take-review.css");

    expect(inspector).toContain("cameraContinuityKey");
    expect(inspector).toContain("preferredCamera");
    expect(inspector).toContain("compact\n            key={item.clip_id}");
    expect(inspector).toContain('<details className="take-inspector-evidence">');
    expect(inspector.indexOf("<EditorialDecisionPanel")).toBeLessThan(inspector.indexOf('<details className="take-inspector-evidence">'));
    expect(css).toContain(".take-inspector .inspector-angle-cards");
    expect(css).toContain("display: flex");
    expect(css).toContain("max-height: 340px");
  });

  it("supports continuous Take browsing without a tiny select target", () => {
    const list = read("./VirtualTakeList.tsx");

    expect(list).toContain("tabIndex={selected ? 0 : -1}");
    expect(list).toContain('aria-keyshortcuts="ArrowUp ArrowDown Home End"');
    expect(list).toContain('event.key === "ArrowUp"');
    expect(list).toContain('event.key === "ArrowDown"');
    expect(list).toContain('if ((event.target as HTMLElement).closest("button")) return;');
  });
});
