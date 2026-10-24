import { describe, expect, it } from "vitest";
import baseline from "../../development-baseline.json";

describe("Desktop development baseline", () => {
  it("treats main as the active baseline", () => {
    expect(baseline.contract).toBe("desktop_development_baseline.v1");
    expect(baseline.branch).toBe("main");
    expect(baseline.state).toBe("active_development_baseline");
    expect(baseline.desktop_path).toBe("desktop");
  });

  it("keeps current product capabilities implemented", () => {
    for (const capability of Object.values(baseline.capabilities)) {
      expect(capability.code_status).toBe("implemented");
    }
  });

  it("keeps heavy workstreams isolated", () => {
    expect(baseline.isolation_policy.production_project_tabs_are_product_surfaces).toBe(true);
    expect(baseline.isolation_policy.team_web_is_top_level_workspace).toBe(true);
    expect(baseline.isolation_policy.heavy_capabilities_require_isolated_module_or_worktree).toBe(true);
    for (const workstream of Object.values(baseline.active_workstreams) as Array<{ branch?: unknown; status?: unknown }>) {
      expect(typeof workstream.branch).toBe("string");
      expect(typeof workstream.status).toBe("string");
    }
  });

  it("does not downgrade unverified release gates", () => {
    for (const value of Object.values(baseline.release_gates)) {
      expect(value).toBe("required");
    }
  });
});
