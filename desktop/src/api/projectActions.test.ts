import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { isTauri } from "@tauri-apps/api/core";
import { HostConnectionError } from "./host";
import { ProjectActionClient } from "./projectActions";

const mockedIsTauri = vi.mocked(isTauri);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("ProjectActionClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockedIsTauri.mockReturnValue(false);
  });

  it("reads an explicit device-local project location without persisting it", async () => {
    const browserFetch = vi.fn(async () => jsonResponse({
      contract: "project_local_location.v1",
      project_id: "p/1",
      project_dir: "/Users/editor/MirrorOrder/projects/p1",
      output_dir: "/Users/editor/MirrorOrder/projects/p1/output",
      project_exists: true,
      output_exists: true,
      device_paths_exposed: true,
      scope: "device_local_response",
    }));
    vi.stubGlobal("fetch", browserFetch);

    const payload = await new ProjectActionClient("http://127.0.0.1:8765").localLocation("p/1");

    expect(payload.scope).toBe("device_local_response");
    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/local-location$/);
    expect(browserFetch.mock.calls[0]?.[1]?.method).toBeUndefined();
  });

  it("rejects a response that does not declare the device-local path boundary", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      contract: "project_local_location.v1",
      project_id: "p1",
      project_dir: "/tmp/p1",
      output_dir: "/tmp/p1/output",
      project_exists: true,
      output_exists: true,
      device_paths_exposed: false,
      scope: "project",
    })));

    await expect(new ProjectActionClient("http://127.0.0.1:8765").localLocation("p1")).rejects.toBeInstanceOf(HostConnectionError);
  });
});
