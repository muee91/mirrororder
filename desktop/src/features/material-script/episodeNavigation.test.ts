import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const source = readFileSync(fileURLToPath(new URL("./MaterialScriptWorkbench.tsx", import.meta.url)), "utf8");

describe("material/script episode navigation", () => {
  it("keeps the complete episode list reachable", () => {
    expect(source).toContain("const episodeButtons = model?.episodes ?? []");
    expect(source).not.toMatch(/episodes\.slice\(0,\s*32\)/);
  });
});
