import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("../script/ScriptWorkspace.tsx", import.meta.url)), "utf8");

describe("script episode navigation", () => {
  it("keeps the complete episode list reachable from the Script workspace", () => {
    expect(source).toContain("{model.episodes.map((episode) => (");
    expect(source).toContain('aria-label="剧本集数"');
    expect(source).not.toMatch(/episodes\.slice\(0,\s*32\)/);
  });
});
