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

  it("keeps save-as and collect device paths only in local action request bodies", async () => {
    const browserFetch = vi.fn<typeof fetch>(async (input) => {
      const path = String(input);
      return jsonResponse({
        contract: "project_transfer_task.v1",
        project_id: "p/1",
        operation: path.endsWith("/collect") ? "collect" : "save-as",
        task: { task_id: "task_1", scope: "project", status: "queued" },
      }, 202);
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new ProjectActionClient("http://127.0.0.1:8765");

    await client.saveProjectAs("p/1", "/Volumes/Archive/Demo Copy.mirrorproj", { name: "Demo Copy" });
    await client.collectProject("p/1", "/Volumes/Archive/Demo.mirrorpkg", { includeMedia: true });

    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/save-as$/);
    expect(JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body))).toMatchObject({
      destination: "/Volumes/Archive/Demo Copy.mirrorproj",
      name: "Demo Copy",
      include_cache: false,
    });
    expect(String(browserFetch.mock.calls[1]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/collect$/);
    expect(JSON.parse(String(browserFetch.mock.calls[1]?.[1]?.body))).toMatchObject({
      destination: "/Volumes/Archive/Demo.mirrorpkg",
      include_cache: false,
      include_media: true,
    });
  });
});
