import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Timeline read-model loading", () => {
  it("keeps Review and assembly reads independent and explains partial failures", () => {
    const source = read("./useTimelineWorkbenchModel.ts");

    expect(source).toContain("Promise.allSettled([host.reviewModel(projectId), production.assemblyTimeline(projectId)])");
    expect(source).toContain("审阅上下文读取失败：");
    expect(source).toContain("初始顺片读取失败：");
    expect(source).not.toContain("Promise.all([host.reviewModel(projectId), production.assemblyTimeline(projectId)])");
  });
});
