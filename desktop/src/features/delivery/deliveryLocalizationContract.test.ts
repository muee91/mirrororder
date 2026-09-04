import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./DeliveryWorkbench.tsx", import.meta.url)), "utf8");

describe("delivery Chinese product language", () => {
  it("uses Chinese workflow labels while preserving NLE product and format names", () => {
    expect(source).toContain("最终剪辑 → NLE");
    expect(source).toContain("交付前检查");
    expect(source).toContain("当前剪辑版本");
    expect(source).toContain("视频片段");
    expect(source).toContain("多机位片段");
    expect(source).toContain("Final Cut Pro");
    expect(source).toContain("Adobe Premiere Pro");
    expect(source).toContain("FCPXML");
  });
});
