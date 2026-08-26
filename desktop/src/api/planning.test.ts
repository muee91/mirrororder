import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { EditorialClient, PlanningClient } from "./planning";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("PlanningClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("keeps coverage, rough cut and assembly on read-only first-party Host routes", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/coverage")) return jsonResponse({ contract: "coverage.v1", revision: "c1", project_id: "p/1", filters: {}, summary: { scenes: 0, mapped_take_groups: 0, angles: 0, known_shots: 0, unknown_shots: 0, continuity_risks: 0, unobserved_scenes: 0, unplaced_groups: 0, episode_only_groups: 0, script_supervisor_groups: 0 }, scenes: [], episode_only_groups: [], unplaced_group_ids: [], semantics: {} });
      if (url.includes("/rough-cut-plan")) return jsonResponse({ contract: "rough_cut_plan.v1", revision: "r1", project_id: "p/1", coverage_revision: "c1", filters: {}, readiness: "ready", summary: {}, scenes: [], semantics: {} });
      return jsonResponse({ contract: "assembly_timeline.v1", revision: "a1", rough_cut_plan_revision: "r1", coverage_revision: "c1", project_id: "p/1", filters: {}, readiness: "ready", duration: 0, summary: { scenes: 0, blocks: 0, statuses: {} }, scenes: [], semantics: {} });
    });
    vi.stubGlobal("fetch", browserFetch);

    const client = new PlanningClient("http://127.0.0.1:8765/");
    await expect(client.coverage("p/1", { episode: 3, sceneId: "S 1" })).resolves.toMatchObject({ contract: "coverage.v1" });
    await expect(client.roughCut("p/1", { episode: 3 })).resolves.toMatchObject({ contract: "rough_cut_plan.v1" });
    await expect(client.assembly("p/1", { sceneId: "S 1" })).resolves.toMatchObject({ contract: "assembly_timeline.v1" });

    expect(String(browserFetch.mock.calls[0]?.[0])).toContain("/api/v1/projects/p%2F1/coverage?");
    expect(String(browserFetch.mock.calls[0]?.[0])).toContain("episode=3");
    expect(String(browserFetch.mock.calls[0]?.[0])).toContain("scene_id=S+1");
    expect(String(browserFetch.mock.calls[1]?.[0])).toContain("/rough-cut-plan?episode=3");
    expect(String(browserFetch.mock.calls[2]?.[0])).toContain("/assembly-timeline?scene_id=S+1");
    expect(browserFetch.mock.calls.every((call) => (call[1]?.method ?? "GET") === "GET")).toBe(true);
  });
});

describe("EditorialClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("writes only the explicit Host-local final editorial decision contract", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/api\/v1\/projects\/p%2F1\/editorial-decision$/);
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        target_kind: "group",
        group_id: "g1",
        state: "best",
        actor: "editor",
        expected_revision: 7,
      });
      return jsonResponse({
        editorial: { version: 2, revision: 8, updated_at: "now", opinions: {}, decisions: { "group|g1": { target: { kind: "group", group_id: "g1", segment_id: "" }, state: "best", actor: "editor", updated_at: "now" } } },
        group: { revision: 8, opinions: { group: [], assignments: [] }, decision: { group: { target: { kind: "group", group_id: "g1", segment_id: "" }, state: "best", actor: "editor", updated_at: "now" }, assignments: [] } },
      });
    });
    vi.stubGlobal("fetch", browserFetch);

    const result = await new EditorialClient("http://127.0.0.1:8765").decision("p/1", {
      targetKind: "group",
      groupId: "g1",
      state: "best",
      actor: " editor ",
      expectedRevision: 7,
    });
    expect(result.editorial.revision).toBe(8);
    expect(result.editorial.decisions["group|g1"]?.state).toBe("best");
  });

  it("surfaces stale revision conflicts as HTTP 409", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "editorial revision 已变化" }, 409)));
    await expect(new EditorialClient("http://127.0.0.1:8765").decision("p1", {
      targetKind: "group",
      groupId: "g1",
      state: "keep",
      actor: "editor",
      expectedRevision: 1,
    })).rejects.toMatchObject({ status: 409 });
  });
});
