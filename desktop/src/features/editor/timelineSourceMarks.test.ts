import { describe, expect, it } from "vitest";
import type { TimelineSourceOption } from "./timelineSourceEditing";
import { clampSourceCursor, sourceOptionEnd } from "./timelineSourceMarks";

const option: TimelineSourceOption = {
  source: { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 600 },
  groupId: "g1",
  camera: "A",
  availableIn: 120,
  availableDuration: 240,
  multicamGroupId: "g1",
  label: "A.mov · g1 · A",
};

describe("timeline source marks", () => {
  it("clamps the source cursor to current playable Review evidence", () => {
    expect(sourceOptionEnd(option)).toBe(360);
    expect(clampSourceCursor(option, 90)).toBe(120);
    expect(clampSourceCursor(option, 240.4)).toBe(240);
    expect(clampSourceCursor(option, 500)).toBe(360);
  });
});
