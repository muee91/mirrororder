import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { DesktopClient } from "./desktop";

function jsonResponse(payload: unknown): Response {
  return new Response(JSON.stringify(payload), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("DesktopClient project task status", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads the existing Python TaskManager projection without mutations", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toEndWith("/api/v1/projects/p%2F1/tasks");
      expect(init?.method).toBe("GET");
      expect(init?.body).toBeUndefined();
      return jsonResponse({
        tasks: [{
          task_id: "task-1",
          type: "prepare_project",
          status: "running",
          stage: "analysis",
          progress: { done: 3, total: 10 },
          started_at: "2026-08-25T00:00:00+00:00",
        }],
      });
    });
    vi.stubGlobal("fetch", browserFetch);

    const tasks = await new DesktopClient("http://127.0.0.1:8765").projectTasks("p/1");

    expect(tasks).toHaveLength(1);
    expect(tasks[0]).toMatchObject({ task_id: "task-1", status: "running", stage: "analysis" });
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });
});
