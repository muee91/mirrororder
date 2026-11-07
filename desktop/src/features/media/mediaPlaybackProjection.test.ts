import { describe, expect, it } from "vitest";
import { canPreviewReviewPlayback } from "./mediaPlaybackProjection";

describe("media playback projection", () => {
  it("only projects verified media or an explicit legacy available=true result", () => {
    expect(canPreviewReviewPlayback({ state: "verified" })).toBe(true);
    expect(canPreviewReviewPlayback({ state: undefined, available: true })).toBe(true);
    expect(canPreviewReviewPlayback({ state: "missing", available: true })).toBe(false);
    expect(canPreviewReviewPlayback({ state: "unknown", available: true })).toBe(false);
    expect(canPreviewReviewPlayback({ state: undefined, available: undefined })).toBe(false);
  });
});
