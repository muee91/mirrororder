import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => false),
}));

vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: vi.fn(),
}));

import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  HostConnection,
  HostConnectionError,
  type HostLaunchResult,
  type HostProcessStatus,
  type WorkspacePayload,
} from "./host";

const mockedInvoke = vi.mocked(invoke);
const mockedIsTauri = vi.mocked(isTauri);

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
    const browserFetch = vi.fn(async () => jsonResponse(reviewModel));
    vi.stubGlobal("fetch", browserFetch);

    await expect(new HostConnection().reviewModel(" p/1 ")).resolves.toEqual(reviewModel);
    expect(String(browserFetch.mock.calls[0]?.[0])).toEndWith("/api/v1/projects/p%2F1/review-model");
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
});
