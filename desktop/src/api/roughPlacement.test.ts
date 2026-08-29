import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ isTauri: vi.fn(() => false) }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: vi.fn() }));

import { isTauri } from "@tauri-apps/api/core";
import { RoughPlacementClient } from "./roughPlacement";
import { HostConnectionError } from "./host";

const mockedIsTauri = vi.mocked(isTauri);

function jsonResponse(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

describe("RoughPlacementClient", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
    mockedIsTauri.mockReturnValue(false);
  });

  it("keeps preview read-only and does not invent a review revision", async () => {
    const browserFetch = vi.fn(async () => jsonResponse({
      contract: "rough_placement.v1",
      text: "1-10 第1集",
      plans: [],
      resolved_groups: 0,
      missing_take_indices: [],
      requires_confirmation: true,
      applied: false,
    }));
    vi.stubGlobal("fetch", browserFetch);

    await new RoughPlacementClient("http://127.0.0.1:8765").preview("p1", "1-10 第1集");

    const body = JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({ text: "1-10 第1集", confirm: false });
    expect(body.actor).toBeUndefined();
    expect(body.expected_revision).toBeUndefined();
  });

  it("requires the current Review revision when confirming a coarse placement", async () => {
    const browserFetch = vi.fn(async () => jsonResponse({
      contract: "rough_placement.v1",
      text: "1-10 第1集",
      plans: [],
      resolved_groups: 3,
      missing_take_indices: [],
      requires_confirmation: false,
      applied: true,
      review_revision: 8,
    }));
    vi.stubGlobal("fetch", browserFetch);

    await new RoughPlacementClient("http://127.0.0.1:8765").apply("p1", "1-10 第1集", "Editor A", 7);

    const body = JSON.parse(String(browserFetch.mock.calls[0]?.[1]?.body));
    expect(body).toMatchObject({
      text: "1-10 第1集",
      confirm: true,
      actor: "Editor A",
      expected_revision: 7,
    });
  });

  it("surfaces stale Review confirmation as a conflict instead of retrying", async () => {
    const browserFetch = vi.fn(async () => jsonResponse({ error: "Review revision 已变化：当前 r8，请刷新后重试" }, 409));
    vi.stubGlobal("fetch", browserFetch);

    await expect(
      new RoughPlacementClient("http://127.0.0.1:8765").apply("p1", "1-10 第1集", "Editor A", 7),
    ).rejects.toMatchObject({ status: 409 });
    expect(browserFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an empty actor before any confirmed write", async () => {
    const browserFetch = vi.fn();
    vi.stubGlobal("fetch", browserFetch);

    await expect(
      new RoughPlacementClient("http://127.0.0.1:8765").apply("p1", "1-10 第1集", "  ", 7),
    ).rejects.toBeInstanceOf(HostConnectionError);
    expect(browserFetch).not.toHaveBeenCalled();
  });
});
