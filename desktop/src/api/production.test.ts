import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { ProductionClient } from "./production";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("ProductionClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads the revision-safe script supervisor board", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({ contract: "script_supervisor.v2", revision: 4, records: {}, entries: {}, semantics: {} }));
    vi.stubGlobal("fetch", browserFetch);
    const board = await new ProductionClient("http://127.0.0.1:8765/").scriptSupervisor("p/1");
    expect(board.revision).toBe(4);
    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/script-supervisor$/);
  });

  it("sends quick slate text and previous human context to the existing parser", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toMatchObject({ text: "同场下一条 B近", previous: { scene: "12" }, allow_model: true });
      return jsonResponse({ contract: "script_supervisor_parse.v1", input: body.text, result: { scene: "12", shot: "", episode: 1, take_number: 2, status: "unmarked", note: body.text, angle_shots: { B: "closeup" }, range_hint: "", inherit_previous: true, parser: "deterministic" } });
    });
    vi.stubGlobal("fetch", browserFetch);
    const parsed = await new ProductionClient("http://127.0.0.1:8765").parseSlate("p1", "同场下一条 B近", { scene: "12" });
    expect(parsed.result.angle_shots.B).toBe("closeup");
  });

  it("preserves expected revision and actor on supervisor writes", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({
        group_id: "g1",
        expected_revision: 7,
        actor: "editor",
        entry: { note: "B近", angles: { b: { shot_type: "closeup" } } },
      });
      return jsonResponse({ contract: "script_supervisor.v2", revision: 8, records: {}, entries: {}, semantics: {} });
    });
    vi.stubGlobal("fetch", browserFetch);
    await new ProductionClient("http://127.0.0.1:8765").writeSlateEntry("p1", {
      groupId: "g1",
      expectedRevision: 7,
      actor: " editor ",
      entry: { note: "B近", angles: { b: { shot_type: "closeup" } } },
    });
  });

  it("uses the local identity confirmation route without embedding payloads", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body).toEqual({ identity_id: "face-1", label: "演员甲", role_name: "林夏" });
      expect(body.embedding).toBeUndefined();
      return jsonResponse({ identity: { identity_id: "face-1", kind: "face", label: "演员甲", role_name: "林夏", observation_count: 2, take_count: 2, average_confidence: .9, example_group_id: "g1", confirmed: true, created_at: "", updated_at: "", occurrences: [] } });
    });
    vi.stubGlobal("fetch", browserFetch);
    const row = await new ProductionClient("http://127.0.0.1:8765").confirmIdentity("p1", { identityId: "face-1", label: "演员甲", roleName: "林夏" });
    expect(row.confirmed).toBe(true);
  });

  it("keeps assistant and rough-cut reads on their first-party Host endpoints", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("rough-cut-plan")) return jsonResponse({ contract: "rough_cut_plan.v1", revision: "r1", project_id: "p1", coverage_revision: "c1", filters: {}, readiness: "ready", summary: {}, scenes: [], semantics: {} });
      return jsonResponse({ version: 1, contract: "assistant.v1", revision: 2, updated_at: "", summary: "ok", items: [] });
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new ProductionClient("http://127.0.0.1:8765");
    await expect(client.assistant("p1")).resolves.toMatchObject({ contract: "assistant.v1" });
    await expect(client.roughCutPlan("p1", { episode: 3, sceneId: "S 1" })).resolves.toMatchObject({ contract: "rough_cut_plan.v1" });
    expect(String(browserFetch.mock.calls[1]?.[0])).toContain("episode=3");
    expect(String(browserFetch.mock.calls[1]?.[0])).toContain("scene_id=S+1");
  });

  it("reads only cached waveform on GET and submits generation as a durable task", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(url).toMatch(/\/api\/v1\/projects\/p%2F1\/waveform\/clip%2Fa$/);
        expect(JSON.parse(String(init.body))).toEqual({ samples: 64 });
        return jsonResponse({
          contract: "waveform_build.v1",
          project_id: "p/1",
          clip_id: "clip/a",
          task: { task_id: "task_waveform", type: "waveform_build", status: "queued" },
        }, 202);
      }
      expect(init?.method).toBe("GET");
      expect(url).toMatch(/\/api\/v1\/projects\/p%2F1\/waveform\/clip%2Fa\?samples=4096$/);
      return jsonResponse({
        contract: "waveform.v1",
        clip_id: "clip/a",
        samples: 2,
        requested_samples: 4096,
        sample_rate: 4,
        peaks: [0.1, 0.2],
        derived: true,
        editorial_authority: false,
        source_fingerprint: "fp",
      });
    });
    vi.stubGlobal("fetch", browserFetch);

    const client = new ProductionClient("http://127.0.0.1:8765");
    await expect(client.waveform("p/1", "clip/a", 999999)).resolves.toMatchObject({ contract: "waveform.v1", peaks: [0.1, 0.2] });
    await expect(client.buildWaveform("p/1", "clip/a", 1)).resolves.toMatchObject({
      contract: "waveform_build.v1",
      task: { type: "waveform_build", status: "queued" },
    });
    expect(browserFetch).toHaveBeenCalledTimes(2);
  });
});
