import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./SlateWorkbench.tsx", import.meta.url)), "utf8");

describe("slate keyboard flow", () => {
  it("supports parse/confirm and adjacent Take navigation without leaving the capture field", () => {
    expect(source).toContain('event.altKey && event.key === "ArrowUp"');
    expect(source).toContain('event.altKey && event.key === "ArrowDown"');
    expect(source).toContain('(event.metaKey || event.ctrlKey) && event.key === "Enter"');
    expect(source).toContain("已进入下一条 Take");
    expect(source).toContain("quickInputRef.current?.focus()");
  });
});
