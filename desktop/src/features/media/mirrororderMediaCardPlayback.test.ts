import { describe, expect, it } from "vitest";
import { mediaCardFromAngle } from "./MirrorOrderMediaCard";

function angle(state: "verified" | "missing" | "unknown") {
  return {
    clip_id: "C_1",
    media_id: "M_1",
    camera: "A",
    name: "A001.mov",
    timeline_start: 0,
    timeline_end: 4,
    duration: 4,
    source_start: 0,
    source_end: 4,
    playback: { url: "/api/v1/projects/demo/media/C_1", source_start: 0, source_end: 4, state },
  } as const;
}

describe("canonical media card playback state", () => {
  it("does not turn missing or unknown state into a video URL", () => {
    expect(mediaCardFromAngle(angle("verified")).playbackUrl).toBe("/api/v1/projects/demo/media/C_1");
    expect(mediaCardFromAngle(angle("missing"))).toMatchObject({ availabilityState: "missing", available: false });
    expect(mediaCardFromAngle(angle("missing")).playbackUrl).toBeUndefined();
    expect(mediaCardFromAngle(angle("unknown"))).toMatchObject({ availabilityState: "unknown", available: undefined });
    expect(mediaCardFromAngle(angle("unknown")).playbackUrl).toBeUndefined();
  });
});
