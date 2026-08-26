import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { DesktopClient } from "./desktop";

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

describe("provisional media confirmation", () => {
  beforeEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

  it("sends an explicit confirmation without media roots", async () => {
    const browserFetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toMatch(/\/api\/v1\/projects\/demo\/media-binding$/);
      expect(JSON.parse(String(init?.body))).toEqual({
        action: "confirm_provisional",
        media_id: "MP_123",
        candidate_path: "/media/A001.mov",
      });
      return jsonResponse({
        contract: "media_binding.v1",
        project_id: "demo",
        summary: { version: 1, device_id: "d", device_name: "mac", state_path: "/s", roots: [], total: 1, resolved: 1, missing: 0, items: [] },
      });
    });
    vi.stubGlobal("fetch", browserFetch);

    const result = await new DesktopClient("http://127.0.0.1:8765").confirmProvisionalMediaBinding(
      "demo",
      " MP_123 ",
      " /media/A001.mov ",
    );

    expect(result.summary.resolved).toBe(1);
  });

  it("rejects non-provisional identities before transport", () => {
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);
    const client = new DesktopClient("http://127.0.0.1:8765");

    expect(() => client.confirmProvisionalMediaBinding("demo", "M_verified", "/media/A001.mov")).toThrow(
      "只有 provisional media identity 需要确认",
    );
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
