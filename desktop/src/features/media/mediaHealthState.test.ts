import { describe, expect, it } from "vitest";
import { mediaHealthState } from "./mediaHealthState";

describe("media health presentation", () => {
  it("reports ready only when a playable identity exists", () => {
    expect(mediaHealthState({ indexed: true, playable: true })).toBe("ready");
    expect(mediaHealthState({ indexed: false, playable: true })).toBe("ready");
  });

  it("distinguishes index-pending from indexed identity-missing media", () => {
    expect(mediaHealthState({ indexed: false, playable: false })).toBe("index_pending");
    expect(mediaHealthState({ indexed: true, playable: false })).toBe("identity_missing");
  });

  it("promotes an actual playback failure above an existing playback identity", () => {
    expect(mediaHealthState({ indexed: true, playable: true, playbackFailed: true })).toBe("unsupported");
  });
});
