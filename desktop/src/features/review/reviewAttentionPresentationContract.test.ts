import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ReviewWorkbenches.tsx", import.meta.url), "utf8");

describe("review collaboration return-flow contract", () => {
  it("returns unresolved team opinions to the host-side attention queue", () => {
    expect(source).toContain("collaborationAttention");
    expect(source).toContain("labels.push(...collaboration.labels)");
    expect(source).toContain("尚未裁决的团队意见");
    expect(source).toContain("团队反馈待处理");
  });

  it("keeps the editor as the final authority", () => {
    expect(source).toContain("Team Web 的个人意见不被当成最终决定");
    expect(source).toContain("不自动修改归集、个人意见或最终剪辑决定");
  });
});
