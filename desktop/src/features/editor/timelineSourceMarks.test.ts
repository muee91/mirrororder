import { describe, expect, it } from "vitest";
import type { TimelineSourceOption } from "./timelineSourceEditing";
import { clampSourceCursor, markSourceIn, markSourceOut, sourceOptionEnd } from "./timelineSourceMarks";

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

  it("marks In while preserving the existing Out", () => {
    expect(markSourceIn(option, { sourceIn: 120, duration: 200 }, 180)).toEqual({
      sourceIn: 180,
      duration: 140,
    });
  });

  it("marks Out while preserving the existing In", () => {
    expect(markSourceOut(option, { sourceIn: 150, duration: 150 }, 260)).toEqual({
      sourceIn: 150,
      duration: 110,
    });
  });

  it("rejects inverted or zero-length mark ranges", () => {
    expect(() => markSourceIn(option, { sourceIn: 120, duration: 80 }, 200)).toThrow("Mark In 必须早于当前 Mark Out");
    expect(() => markSourceOut(option, { sourceIn: 180, duration: 80 }, 180)).toThrow("Mark Out 必须晚于当前 Mark In");
  });
});
