import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("macOS Tauri bundle configuration", () => {
  it("uses an outer ad-hoc signing identity for resource-bearing App bundles", () => {
    const configPath = resolve(process.cwd(), "src-tauri/tauri.macos.conf.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));

    expect(config.bundle?.macOS?.signingIdentity).toBe("-");
  });
});
