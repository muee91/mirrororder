import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { MediaRoleClient } from "./mediaRoles";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("MediaRoleClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("reads path-free media inventory and shared media roles", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/media-inventory")) {
        return jsonResponse({ contract: "media_inventory.v1", project_id: "p/1", role_revision: 3, summary: { files: 1, indexed: 1, unindexed: 0, labeled: 1, auxiliary: 1 }, items: [{ media_id: "M_1", display_name: "DJI.mov", folder_label: "Drone", inferred_camera: "?", indexed: true, label: { source_role: "aerial", sync_policy: "exclude" } }], semantics: { paths_exposed: false } });
      }
      return jsonResponse({ version: 1, contract: "media_roles.v1", revision: 3, updated_at: "now", media: { M_1: { source_role: "aerial", sync_policy: "exclude" } } });
    });
    vi.stubGlobal("fetch", browserFetch);

    const client = new MediaRoleClient("http://127.0.0.1:8765/");
    await expect(client.inventory("p/1")).resolves.toMatchObject({ summary: { auxiliary: 1 }, semantics: { paths_exposed: false } });
    await expect(client.roles("p/1")).resolves.toMatchObject({ revision: 3 });
    expect(String(browserFetch.mock.calls[0]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/media-inventory$/);
    expect(String(browserFetch.mock.calls[1]?.[0])).toMatch(/\/api\/v1\/projects\/p%2F1\/media-roles$/);
  });

  it("preserves expected revision, actor and human media facts on writes", async () => {
    const browserFetch = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      expect(init?.method).toBe("POST");
      expect(JSON.parse(String(init?.body))).toEqual({
        expected_revision: 4,
        actor: "editor",
        changes: [{
          media_id: "M_1",
          entry: {
            display_name: "DJI.mov",
            camera_override: "D",
            source_role: "aerial",
            sync_policy: "exclude",
            scene_id: "12-3",
            role_label: "城市建立镜头",
            note: "开场可用",
          },
        }],
      });
      return jsonResponse({ version: 1, contract: "media_roles.v1", revision: 5, updated_at: "now", media: {} });
    });
    vi.stubGlobal("fetch", browserFetch);

    const result = await new MediaRoleClient("http://127.0.0.1:8765").save("p1", {
      expectedRevision: 4,
      actor: " editor ",
      mediaId: "M_1",
      entry: {
        display_name: "DJI.mov",
        camera_override: "D",
        source_role: "aerial",
        sync_policy: "exclude",
        scene_id: "12-3",
        role_label: "城市建立镜头",
        note: "开场可用",
      },
    });
    expect(result.revision).toBe(5);
  });

  it("surfaces revision conflicts instead of silently overwriting shared roles", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ error: "media role revision conflict" }, 409)));
    await expect(new MediaRoleClient("http://127.0.0.1:8765").save("p1", {
      expectedRevision: 1,
      actor: "editor",
      mediaId: "M_1",
      entry: { source_role: "broll", sync_policy: "exclude" },
    })).rejects.toMatchObject({ status: 409 });
  });
});
