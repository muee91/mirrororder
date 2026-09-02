import { readFileSync } from "node:fs";
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

  it("describes runtime playback failure without guessing whether storage or codec caused it", () => {
    const indicators = readFileSync(new URL("../../components/StatusIndicators.tsx", import.meta.url), "utf8");
    expect(indicators).toContain('unsupported: { label: "无法播放"');
    expect(indicators).not.toContain('unsupported: { label: "编码不支持"');
  });
});
