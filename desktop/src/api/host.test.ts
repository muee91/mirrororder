import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import {
  HostConnection,
  HostConnectionError,
  type HostLaunchResult,
  type HostProcessStatus,
  type WorkspacePayload,
} from "./host";
import { EditorialClient } from "./planning";

const mockedInvoke = vi.mocked(invoke);
const mockedIsTauri = vi.mocked(isTauri);
const mockedTauriFetch = vi.mocked(tauriFetch);

const workspace: WorkspacePayload = {
  workspace_id: "ws_demo",
  workspace: "Demo",
  api_version: "v1",
  projects: [
    {
      project_id: "p1",
      name: "Episode 1",
      input_kind: "fcpxml",
    },
  ],
};

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("HostConnection", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockedIsTauri.mockReturnValue(false);
    mockedInvoke.mockReset();
    mockedTauriFetch.mockReset();
  });

  it("normalizes a trailing slash from the base URL", () => {
    expect(new HostConnection("  http://127.0.0.1:8765/// ").baseUrl).toBe("http://127.0.0.1:8765");
  });

  it("rejects non-http host addresses", () => {
    expect(() => new HostConnection("127.0.0.1:8765")).toThrow(HostConnectionError);
  });

  it("connects through the browser transport and returns the workspace project list", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/ping")) {
        return jsonResponse({ status: "ok", service: "mirrororder-host" });
      }
      if (url.endsWith("/api/v1/workspace")) {
        return jsonResponse(workspace);
      }
      return jsonResponse({ error: "not found" }, 404);
    });
    vi.stubGlobal("fetch", browserFetch);

    const snapshot = await new HostConnection().connect();

    expect(snapshot.ping.service).toBe("mirrororder-host");
    expect(snapshot.workspace.workspace_id).toBe("ws_demo");
    expect(snapshot.projects).toEqual(workspace.projects);
    expect(browserFetch).toHaveBeenCalledTimes(2);
  });

  it("builds the single-Host media endpoint without using workspace-local paths", () => {
    expect(new HostConnection("http://127.0.0.1:8765").mediaUrl(" p/1 ", " c 1 ")).toBe(
      "http://127.0.0.1:8765/api/v1/projects/p%2F1/media/c%201",
    );
  });

  it("reads the existing review.v1 projection without deriving business rules", async () => {
    const reviewModel = {
      contract_version: "review.v1",
      project: { project_id: "p/1", name: "Episode 1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
      revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 3 },
      capabilities: {},
      summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
      episodes: [],
      take_groups: [],
      script_gaps: [],
      review_state: {},
    };
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(reviewModel));
    vi.stubGlobal("fetch", browserFetch);

    await expect(new HostConnection().reviewModel(" p/1 ")).resolves.toEqual(reviewModel);
    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/review-model$/);
  });

  it("serves concurrent review-model readers from one in-flight request", async () => {
    const payload = {
      contract_version: "review.v1",
      project: { project_id: "p_dedup", name: "Episode 1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
      revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 3 },
      capabilities: {},
      summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
      episodes: [],
      take_groups: [],
      script_gaps: [],
      review_state: {},
    };
    let calls = 0;
    const browserFetch = vi.fn(async () => {
      calls += 1;
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", browserFetch);

    // Each workspace surface builds its own HostConnection; the cache has to be
    // shared anyway, otherwise ProjectHome-to-canvas switching re-pulls the payload.
    const clients = [new HostConnection(), new HostConnection(), new HostConnection()];
    const [first, second, third] = await Promise.all([
      clients[0]!.reviewModel("p_dedup"),
      clients[1]!.reviewModel("p_dedup"),
      clients[2]!.reviewModel("p_dedup"),
    ]);

    expect(calls).toBe(1);
    expect(first.take_groups).toEqual([]);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("hands cached review models out as copies so one surface cannot mutate another", async () => {
    const payload = {
      contract_version: "review.v1",
      project: { project_id: "p_copy", name: "Episode 1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
      revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 3 },
      capabilities: {},
      summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
      episodes: [],
      take_groups: [{ group_id: "G1", angles: [{ clip_id: "C1", playback: { url: "http://127.0.0.1:8765/media/C1" } }] }],
      script_gaps: [],
      review_state: {},
    };
    const browserFetch = vi.fn(async () => jsonResponse(payload));
    vi.stubGlobal("fetch", browserFetch);

    const host = new HostConnection();
    const first = await host.reviewModel("p_copy");
    first.summary.take_groups = 99;
    const second = await host.reviewModel("p_copy");

    expect(second.summary.take_groups).toBe(1);
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  it("drops the cached review model when a human placement write is attempted", async () => {
    const payload = {
      contract_version: "review.v1",
      project: { project_id: "p_write", name: "Episode 1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
      revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 3 },
      capabilities: {},
      summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
      episodes: [],
      take_groups: [],
      script_gaps: [],
      review_state: {},
    };
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      if (String(init?.method) === "POST") {
        return jsonResponse({ revision: 4, groups: [] });
      }
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", browserFetch);

    const host = new HostConnection();
    await host.reviewModel("p_write");
    await host.setGroupPlacement("p_write", {
      groupId: "G1",
      actor: "剪辑指导",
      episodeIds: [1],
      expectedRevision: 3,
    });
    await host.reviewModel("p_write");

    const reads = browserFetch.mock.calls.filter(([, init]) => String(init?.method) !== "POST");
    expect(reads).toHaveLength(2);
  });

  it("does not cache a failed review-model read", async () => {
    const payload = {
      contract_version: "review.v1",
      project: { project_id: "p_fail", name: "Episode 1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
      revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 3 },
      capabilities: {},
      summary: { automation: {}, script_gaps: 0, take_groups: 0, episodes: 1 },
      episodes: [],
      take_groups: [],
      script_gaps: [],
      review_state: {},
    };
    let attempts = 0;
    const browserFetch = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) return jsonResponse({ error: "temporarily unavailable" }, 503);
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", browserFetch);

    const host = new HostConnection();
    await expect(host.reviewModel("p_fail")).rejects.toBeTruthy();
    await expect(host.reviewModel("p_fail")).resolves.toMatchObject({ contract_version: "review.v1" });
    expect(attempts).toBe(2);
  });

  it("busts the shared review-model cache on a final editorial decision", async () => {
    const payload = {
      contract_version: "review.v1",
      project: { project_id: "p_ed", name: "Episode 1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
      revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 3 },
      capabilities: {},
      summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
      episodes: [],
      take_groups: [],
      script_gaps: [],
      review_state: {},
    };
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if (String(init?.method) === "POST") {
        return jsonResponse({ editorial: { revision: 9, opinions: {}, decisions: {} }, group: { revision: 9, opinions: { group: [], assignments: [] }, decision: { group: {}, assignments: [] } } });
      }
      return jsonResponse(payload);
    });
    vi.stubGlobal("fetch", browserFetch);

    const host = new HostConnection();
    await host.reviewModel("p_ed");
    // The decision is written by EditorialClient, a different class than the one
    // that reads review-model — the cache must still be invalidated across them.
    await new EditorialClient("http://127.0.0.1:8765").decision("p_ed", {
      targetKind: "group",
      groupId: "g1",
      state: "best",
      actor: "剪辑指导",
      expectedRevision: 8,
    });
    await host.reviewModel("p_ed");

    const reads = browserFetch.mock.calls.filter(([, init]) => String(init?.method) !== "POST");
    expect(reads).toHaveLength(2);
  });

  it("writes episode-only placement through the atomic review action", async () => {
    const saved = {
      version: 2,
      revision: 4,
      updated_at: "2026-08-25T00:00:00+00:00",
      assignments: {},
      groups: {},
      clips: {},
      placements: { g1: { episode_ids: [3], script_segment_ids: [] } },
    };
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(saved));
    vi.stubGlobal("fetch", browserFetch);

    await expect(
      new HostConnection().setGroupPlacement("p1", {
        groupId: "g1",
        actor: "Editor A",
        expectedRevision: 3,
        episodeIds: [3, 3],
        interaction: "drag",
        sourceSurface: "desktop-v2-material",
      }),
    ).resolves.toEqual(saved);

    const [url, init] = browserFetch.mock.calls[0] ?? [];
    expect(String(url)).toMatch(/\/api\/v1\/projects\/p1\/review$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      action: "set_group_placement",
      group_id: "g1",
      episode_ids: [3],
      script_segment_ids: [],
      actor: "Editor A",
      interaction: "drag",
      source_surface: "desktop-v2-material",
      expected_revision: 3,
    });
  });

  it("writes precise script placement without changing editorial state", async () => {
    const saved = {
      version: 2,
      revision: 5,
      updated_at: "2026-08-25T00:00:00+00:00",
      assignments: {},
      groups: {},
      clips: {},
      placements: {},
    };
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(saved));
    vi.stubGlobal("fetch", browserFetch);

    await new HostConnection().setGroupPlacement("p1", {
      groupId: "g1",
      actor: "Editor A",
      episodeIds: [3],
      scriptSegmentIds: ["S_12", "S_12"],
      sourceSurface: "desktop-v2-script",
    });

    const payload = JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      action: "set_group_placement",
      group_id: "g1",
      episode_ids: [3],
      script_segment_ids: ["S_12"],
    });
    expect(payload.state).toBeUndefined();
  });

  it("writes exclusion as an independent fact, not a legacy creative state", async () => {
    const saved = { version: 2, revision: 7, updated_at: "", assignments: {}, groups: {}, clips: {}, placements: {}, exclusions: {} };
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(saved));
    vi.stubGlobal("fetch", browserFetch);

    const connection = new HostConnection();
    await connection.setGroupExclusion("p1", {
      groupId: "g1",
      actor: "Editor A",
      excluded: true,
      expectedRevision: 6,
      interaction: "drag",
      sourceSurface: "slate-table",
      sourceClipId: "clip-1",
    });
    await connection.setGroupExclusion("p1", {
      groupId: "g1",
      actor: "Editor A",
      excluded: false,
      expectedRevision: 7,
      sourceSurface: "slate-table",
    });

    expect(browserFetch).toHaveBeenCalledTimes(2);
    const excluded = JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body));
    expect(excluded).toMatchObject({
      action: "set_group_exclusion",
      group_id: "g1",
      expected_revision: 6,
      source_surface: "slate-table",
      source_clip_id: "clip-1",
    });
    expect(excluded.state).toBeUndefined();
    expect(excluded.editorial_decision).toBeUndefined();
    const restored = JSON.parse(String(browserFetch.mock.calls[1]?.[1]?.body));
    expect(restored).toMatchObject({ action: "clear_group_exclusion", group_id: "g1", expected_revision: 7 });
    expect(restored.state).toBeUndefined();
  });

  it("validates expected Review revisions before sending a write", async () => {
    const connection = new HostConnection();
    await expect(connection.setGroupPlacement("p1", { groupId: "g1", actor: "Editor", expectedRevision: -1, episodeIds: [1] })).rejects.toThrow("有效 expected_revision");
    await expect(connection.clearGroupPlacement("p1", { groupId: "g1", actor: "Editor", expectedRevision: Number.NaN })).rejects.toThrow("有效 expected_revision");
  });

  it("rejects placement writes without an actor or target", async () => {
    const connection = new HostConnection();
    await expect(connection.setGroupPlacement("p1", { groupId: "g1", actor: "", episodeIds: [1] })).rejects.toThrow(
      "写入人工归集前需要审核昵称",
    );
    await expect(connection.setGroupPlacement("p1", { groupId: "g1", actor: "Editor" })).rejects.toThrow(
      "人工归集至少需要 episode_id 或 script_segment_id",
    );
  });

  it("clears only the manual placement through the matching review action", async () => {
    const saved = {
      version: 2,
      revision: 6,
      updated_at: "2026-08-25T00:00:00+00:00",
      assignments: {},
      groups: {},
      clips: {},
      placements: {},
    };
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse(saved));
    vi.stubGlobal("fetch", browserFetch);

    await new HostConnection().clearGroupPlacement("p1", {
      groupId: "g1",
      actor: "Editor A",
    });
    const payload = JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body));
    expect(payload).toMatchObject({
      action: "clear_group_placement",
      group_id: "g1",
      actor: "Editor A",
    });
  });

  it("rejects an empty project id for review-model", async () => {
    await expect(new HostConnection().reviewModel("   ")).rejects.toThrow("读取 review-model 需要 project_id");
  });

  it("rejects an incompatible review-model contract", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        jsonResponse({
          contract_version: "review.v2",
          project: { project_id: "p1" },
        }),
      ),
    );

    await expect(new HostConnection().reviewModel("p1")).rejects.toThrow(
      "不支持的 review-model contract：review.v2",
    );
  });

  it("preserves Host API errors and status codes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "workspace unavailable" }, 503)));

    await expect(new HostConnection().workspace()).rejects.toMatchObject({
      name: "HostConnectionError",
      message: "workspace unavailable",
      status: 503,
    });
  });

  it("rejects a ping that does not report ok", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) =>
        String(input).endsWith("/api/v1/ping")
          ? jsonResponse({ status: "starting", service: "mirrororder-host" })
          : jsonResponse(workspace),
      ),
    );

    await expect(new HostConnection().connect()).rejects.toThrow("Host ping 返回异常状态：starting");
  });

  it("does not allow browser preview to manage the Python process", async () => {
    const connection = new HostConnection();
    await expect(connection.startLocal("workspace.toml")).rejects.toThrow("浏览器预览无法启动本地 Python Host");
    await expect(connection.managedStatus()).rejects.toThrow("浏览器预览无法检查本地 Python Host");
    await expect(connection.stopLocal()).rejects.toThrow("浏览器预览无法停止本地 Python Host");
  });

  it("validates the requested Host port before invoking Rust", async () => {
    mockedIsTauri.mockReturnValue(true);
    await expect(new HostConnection().startLocal("workspace.toml", 0)).rejects.toThrow("Host 端口必须是 1–65535 的整数");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("exposes managed Host lifecycle commands in Tauri", async () => {
    mockedIsTauri.mockReturnValue(true);
    const launch: HostLaunchResult = {
      pid: 42,
      base_url: "http://127.0.0.1:8765",
      already_running: false,
    };
    const status: HostProcessStatus = {
      running: true,
      pid: 42,
      base_url: launch.base_url,
      workspace_path: "workspace.toml",
    };
    mockedInvoke
      .mockResolvedValueOnce(launch as never)
      .mockResolvedValueOnce(status as never)
      .mockResolvedValueOnce(undefined as never);

    const connection = new HostConnection();
    await expect(connection.startLocal(" workspace.toml ")).resolves.toEqual(launch);
    await expect(connection.managedStatus()).resolves.toEqual(status);
    await expect(connection.stopLocal()).resolves.toBeUndefined();
    expect(mockedInvoke).toHaveBeenCalledWith("start_python_host", {
      workspacePath: "workspace.toml",
      port: 8765,
    });
  });

  it("does not retry a failed workspace projection after Rust verified the managed Host", async () => {
    mockedIsTauri.mockReturnValueOnce(true).mockReturnValue(false);
    mockedInvoke.mockResolvedValueOnce({
      pid: 42,
      base_url: "http://127.0.0.1:8765",
      already_running: false,
    } as never);
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input).endsWith("/api/v1/ping")) {
        return jsonResponse({ status: "ok", service: "mirrororder-host" });
      }
      return jsonResponse({ error: "workspace unavailable" }, 503);
    });
    vi.stubGlobal("fetch", browserFetch);

    await expect(new HostConnection().startAndConnect("workspace.toml")).rejects.toMatchObject({
      message: "workspace unavailable",
      status: 503,
    });
    expect(browserFetch).toHaveBeenCalledTimes(2);
  });

  it("does not use tauri-plugin-http AbortSignal cancellation for a managed Host read", async () => {
    mockedIsTauri.mockReturnValue(true);
    mockedInvoke.mockResolvedValueOnce({
      pid: 42,
      base_url: "http://127.0.0.1:8765",
      already_running: false,
    } as never);
    mockedTauriFetch.mockImplementation(async (input, init) =>
      String(input).endsWith("/api/v1/ping")
        ? jsonResponse({ status: "ok", service: "mirrororder-host" })
        : jsonResponse(workspace),
    );

    await expect(new HostConnection().startAndConnect("workspace.toml")).resolves.toMatchObject({
      ping: { service: "mirrororder-host" },
      workspace,
    });
    expect(mockedTauriFetch).toHaveBeenCalledTimes(2);
    for (const [, init] of mockedTauriFetch.mock.calls) {
      expect(init?.signal).toBeUndefined();
      expect((init as RequestInit & { connectTimeout?: number })?.connectTimeout).toBe(20_000);
    }
  });
});
