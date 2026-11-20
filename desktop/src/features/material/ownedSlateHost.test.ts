import { describe, expect, it } from "vitest";
import { isOwnedSlateHost } from "./ownedSlateHost";

const baseUrl = "http://127.0.0.1:8765";
const status = { running: true, healthy: true, pid: 101, workspace_path: "/private/tmp/workspace.toml", base_url: baseUrl };

describe("daily slate managed host availability", () => {
  it("enables only the reported healthy local managed destination", () => {
    expect(isOwnedSlateHost(baseUrl, status)).toBe(true);
    expect(isOwnedSlateHost("http://127.0.0.1:8766", status)).toBe(false);
    expect(isOwnedSlateHost("https://remote.test", { ...status, base_url: "https://remote.test" })).toBe(false);
    expect(isOwnedSlateHost("http://localhost:8765", { ...status, base_url: "http://localhost:8765" })).toBe(false);
  });
  it("keeps the legacy workbench on unavailable or incomplete ownership", () => {
    for (const invalid of [{ running: false }, { healthy: false }, { healthy: undefined },
      { pid: null }, { pid: -1 }, { workspace_path: "" }, { workspace_path: null }, { base_url: null }]) {
      expect(isOwnedSlateHost(baseUrl, { ...status, ...invalid })).toBe(false);
    }
  });
});
