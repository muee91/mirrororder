import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./GoldenSlateWorkbench.tsx", import.meta.url)), "utf8");

describe("golden slate keyboard flow", () => {
  it("keeps keyboard-first production capture on the primary Slate canvas", () => {
    expect(source).toContain('(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s"');
    expect(source).toContain('(event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n"');
    expect(source).toContain('event.key.toLowerCase() === "i"');
    expect(source).toContain('event.key.toLowerCase() === "o"');
    expect(source).toContain("同场下一条");
    expect(source).toContain("同上");
    expect(source).toContain("空白");
    expect(source).toContain("已填入解析结果");
    expect(source).toContain("；仍需保存。");
    expect(source).toContain("保存后才写入项目");
  });
});
