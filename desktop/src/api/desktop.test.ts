import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn(), isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { DesktopClient, type FrontendSettings } from "./desktop";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("DesktopClient", () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("reads host-local desktop diagnostics", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => jsonResponse({
      contract: "desktop_status.v1", workspace: { workspace_id: "ws1", name: "W", path: "/w", projects: 2 },
      environment: { python: { executable: "/python", version: "3.12" }, commands: [], python_modules: [], multicam_engine: {}, workspaces: [], media_directory_sync_ready: true, identity_runtime: { face: true, speaker: false }, host: "host", platform: "darwin", data_root: "" },
      device_media: { version: 2, device_id: "d", device_name: "mac", state_path: "/state" },
    }));
    vi.stubGlobal("fetch", browserFetch);
    const status = await new DesktopClient("http://127.0.0.1:8765/").status();
    expect(status.contract).toBe("desktop_status.v1");
    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/desktop-status$/);
  });

  it("reads and writes the existing Python frontend settings contract", async () => {
    const settings: FrontendSettings = { version: 1, theme: "dark", density: "compact", default_mode: "unassigned", default_episode: 3, poll_interval_ms: 5000, update_sound: false, show_unknown_count: true };
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/api\/v1\/settings$/);
      if (init?.method === "POST") expect(JSON.parse(String(init.body))).toEqual(settings);
      return jsonResponse(settings);
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new DesktopClient("http://127.0.0.1:8765");
    await expect(client.frontendSettings()).resolves.toEqual(settings);
    await expect(client.saveFrontendSettings(settings)).resolves.toEqual(settings);
    expect(browserFetch).toHaveBeenCalledTimes(2);
  });

  it("preserves explicit local runtime actions", async () => {
    const runtime = { contract: "local_runtime.v1", local_vision_enabled: true, local_vision_model: "model", face_identity_enabled: true, speaker_identity_enabled: true, vision: { available: true, preparing: false, status: "cached", cache_dir: "/v", cache_bytes: 1 }, identity: { face: { available: true, preparing: false, status: "ready", cache_dir: "/f", cache_bytes: 2 }, speaker: { available: true, preparing: false, status: "ready", cache_dir: "/s", cache_bytes: 3 }, root: "/i" }, mlx_cache_bytes: 1, model_root: "/models", environment: {} };
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/api\/v1\/desktop-local-runtime$/);
      if (init?.method === "POST") expect(JSON.parse(String(init.body))).toEqual({ action: "prepare_identity", kind: "speaker" });
      return jsonResponse(runtime);
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new DesktopClient("http://127.0.0.1:8765");
    await expect(client.localRuntime()).resolves.toMatchObject({ local_vision_model: "model" });
    await expect(client.updateLocalRuntime({ action: "prepare_identity", kind: "speaker" })).resolves.toMatchObject({ contract: "local_runtime.v1" });
  });

  it("delegates team role and status writes to the collaboration adapter", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (init?.method === "POST") {
        expect(url).toMatch(/\/api\/v1\/desktop-collaboration\/usr_abc$/);
        expect(JSON.parse(String(init.body))).toEqual({ role: "manager", status: "active" });
      } else expect(url).toMatch(/\/api\/v1\/desktop-collaboration$/);
      return jsonResponse({ contract: "desktop_collaboration.v1", workspace_id: "ws1", users: [], audit: [] });
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new DesktopClient("http://127.0.0.1:8765");
    await client.collaboration();
    await client.updateCollaborator("usr_abc", { role: "manager", status: "active" });
    expect(browserFetch).toHaveBeenCalledTimes(2);
  });

  it("deduplicates media roots and preserves replace intent", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(JSON.parse(String(init?.body))).toEqual({ action: "replace_and_scan", roots: ["/media/A", "/media/B"] });
      return jsonResponse({ contract: "media_binding.v1", project_id: "p1", summary: { version: 1, device_id: "d", device_name: "mac", state_path: "/s", roots: ["/media/A", "/media/B"], total: 2, resolved: 2, missing: 0, items: [] } });
    });
    vi.stubGlobal("fetch", browserFetch);
    const result = await new DesktopClient("http://127.0.0.1:8765").scanMediaBinding("p1", [" /media/A ", "/media/A", "/media/B"], true);
    expect(result.summary.resolved).toBe(2);
  });

  it("rejects empty media scans before transport", async () => {
    const browserFetch = vi.fn(); vi.stubGlobal("fetch", browserFetch);
    expect(() => new DesktopClient("http://127.0.0.1:8765").scanMediaBinding("p1", [" "])).toThrow("至少需要一个目录");
    expect(browserFetch).not.toHaveBeenCalled();
  });

  it("uses Python preflight before project creation contracts", async () => {
    const calls: Array<{ url: string; body: unknown }> = [];
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input); const body = init?.body ? JSON.parse(String(init.body)) : null; calls.push({ url, body });
      if (url.endsWith("/preflight")) return jsonResponse({ contract: "project_preflight.v1", preflight: { ready: true, errors: [], warnings: [], project_id: "demo" } });
      return jsonResponse({ project_id: "demo", name: "Demo", input_kind: "fcpxml" });
    });
    vi.stubGlobal("fetch", browserFetch);
    const client = new DesktopClient("http://127.0.0.1:8765");
    const payload = { name: "Demo", input_kind: "fcpxml" as const, script: "/script.md", fcpxml: "/a.fcpxml" };
    await expect(client.preflightProject(payload)).resolves.toMatchObject({ ready: true, project_id: "demo" });
    await expect(client.createProject(payload)).resolves.toMatchObject({ project_id: "demo" });
    expect(calls[0]?.url).toMatch(/\/api\/v1\/projects\/preflight$/); expect(calls[1]?.url).toMatch(/\/api\/v1\/projects$/);
  });

  it("echoes project id on destructive delete", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/api\/v1\/projects\/p%2F1\/delete$/); expect(JSON.parse(String(init?.body))).toEqual({ confirm_project_id: "p/1" });
      return jsonResponse({ project_id: "p/1", deleted: true, config_path: "projects/p1/project.toml" });
    });
    vi.stubGlobal("fetch", browserFetch);
    await expect(new DesktopClient("http://127.0.0.1:8765").deleteProject("p/1")).resolves.toMatchObject({ deleted: true });
  });
});
