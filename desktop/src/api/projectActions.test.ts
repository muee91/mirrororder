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
    const browserFetch = vi.fn<typeof fetch>(async () => jsonResponse({
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
    expect(browserFetch.mock.calls[0]?.[1]?.method).toBe("GET");
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

  it("requests an original media path using device-local identifiers", async () => {
    const location = {
      contract: "project_media_location.v1",
      project_id: "p/1",
      clip_id: "clip-1",
      media_id: "media-1",
      file_path: "/tmp/A001.mov",
      exists: true,
      device_paths_exposed: true,
      scope: "device_local_response",
    };
    const browserFetch = vi.fn<typeof fetch>(async () => jsonResponse(location));
    vi.stubGlobal("fetch", browserFetch);

    const client = new ProjectActionClient("http://127.0.0.1:8765");
    await expect(client.mediaLocation("p/1", { clipId: "clip-1", mediaId: "media-1", groupId: "take-1" })).resolves.toEqual(location);

    const [url, init] = browserFetch.mock.calls[0];
    expect(String(url)).toMatch(/\/api\/v1\/projects\/p%2F1\/media-location$/);
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toEqual({ clip_id: "clip-1", media_id: "media-1", group_id: "take-1" });
  });

  it.each([
    { scope: "project", device_paths_exposed: true },
    { scope: "device_local_response", device_paths_exposed: false },
  ])("rejects media location with scope $scope and device_paths_exposed $device_paths_exposed", async (boundary) => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      contract: "project_media_location.v1",
      file_path: "/tmp/A001.mov",
      ...boundary,
    })));

    const client = new ProjectActionClient("http://127.0.0.1:8765");
    await expect(client.mediaLocation("p1", { clipId: "clip-1" })).rejects.toBeInstanceOf(HostConnectionError);
  });

  it("submits external project import through the local project-package endpoint", async () => {
    const browserFetch = vi.fn<typeof fetch>(async () => jsonResponse({
      contract: "project_package_import.v1",
      package: {
        format: "mirrororder-project",
        schema_version: 1,
        legacy: false,
        project_id: "demo",
        name: "Demo",
        package_path: "/Users/editor/Desktop/Demo.mirrorproj",
        device_path_exposed: true,
        scope: "device_local_response",
      },
      task: { task_id: "device_task_1", scope: "device", type: "project_package_import", status: "queued" },
    }, 202));
    vi.stubGlobal("fetch", browserFetch);

    const payload = await new ProjectActionClient("http://127.0.0.1:8765").importPackage("/Users/editor/Desktop/Demo.mirrorproj");

    expect(payload.task.type).toBe("project_package_import");
    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/project-packages\/import$/);
    expect(browserFetch.mock.calls[0]?.[1]?.method).toBe("POST");
    expect(JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body))).toEqual({
      path: "/Users/editor/Desktop/Demo.mirrorproj",
    });
  });

  it("keeps save-as device paths only in local action request bodies", async () => {
    const browserFetch = vi.fn<typeof fetch>(async () => {
      return jsonResponse({
        contract: "project_transfer_task.v1",
        project_id: "p/1",
        operation: "save-as",
        task: { task_id: "task_1", scope: "project", status: "queued" },
      }, 202);
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new ProjectActionClient("http://127.0.0.1:8765");

    await client.saveProjectAs("p/1", "/Volumes/Archive/Demo Copy.mirrorproj", { name: "Demo Copy" });

    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/save-as$/);
    expect(JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      destination: "/Volumes/Archive/Demo Copy.mirrorproj",
      name: "Demo Copy",
      include_cache: false,
    });
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });
});
