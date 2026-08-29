import { describe, expect, it, vi } from "vitest";
import { applySlatePlaybackKey } from "./SlatePlaybackShortcuts";

function video(overrides: Partial<HTMLVideoElement> = {}): HTMLVideoElement {
  return {
    paused: true,
    currentTime: 5,
    playbackRate: 1,
    play: vi.fn(async () => undefined),
    pause: vi.fn(),
    ...overrides,
  } as unknown as HTMLVideoElement;
}

describe("slate playback shortcuts", () => {
  it("uses Space for play/pause", async () => {
    const pausedVideo = video({ paused: true });
    await applySlatePlaybackKey(pausedVideo, " ");
    expect(pausedVideo.play).toHaveBeenCalledTimes(1);

    const playingVideo = video({ paused: false });
    await applySlatePlaybackKey(playingVideo, " ");
    expect(playingVideo.pause).toHaveBeenCalledTimes(1);
  });

  it("uses K to pause and L for forward playback", async () => {
    const current = video({ paused: false, playbackRate: 2 });
    await applySlatePlaybackKey(current, "k");
    expect(current.pause).toHaveBeenCalledTimes(1);

    await applySlatePlaybackKey(current, "l");
    expect(current.playbackRate).toBe(1);
    expect(current.play).toHaveBeenCalledTimes(1);
  });

  it("defines J as a safe one-second backward shuttle step, not fake reverse playback", async () => {
    const current = video({ paused: false, currentTime: 5 });
    await applySlatePlaybackKey(current, "j");
    expect(current.pause).toHaveBeenCalledTimes(1);
    expect(current.currentTime).toBe(4);

    current.currentTime = 0.4;
    await applySlatePlaybackKey(current, "j");
    expect(current.currentTime).toBe(0);
  });
});
