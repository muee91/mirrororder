import { afterEach, describe, expect, it, vi } from "vitest";
import { classifyPlaybackFailure, PLAYBACK_FAILURES } from "./playbackFailure";

function respond(status: number): Response {
  return new Response(null, { status });
}

describe("classifyPlaybackFailure", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("classifies reachable media as a decode failure", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(206)));
    await expect(classifyPlaybackFailure("http://host/media/C_1")).resolves.toBe(PLAYBACK_FAILURES.decode);
  });

  it("classifies 404/403/410 as missing media", async () => {
    for (const status of [404, 403, 410]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(status)));
      await expect(classifyPlaybackFailure("http://host/media/C_1")).resolves.toBe(PLAYBACK_FAILURES.missing);
    }
  });

  it("classifies host errors and fetch rejections as network failures", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(respond(500)));
    await expect(classifyPlaybackFailure("http://host/media/C_1")).resolves.toBe(PLAYBACK_FAILURES.network);
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    await expect(classifyPlaybackFailure("http://host/media/C_1")).resolves.toBe(PLAYBACK_FAILURES.network);
  });
});
