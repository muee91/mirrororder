import { describe, expect, it } from "vitest";
import { boundedWindow, indexClips, indexReviewGaps, parseTimecode, pointerFrame, timecode, toFrame, toMasterFrame, toReviewFrame, toSeconds, visibleClips, zoomWindow } from "./syncTimelineNavigation";
import type { MulticamSyncClip } from "../../api/syncTimeline";

describe("read-only sync timeline navigation", () => {
  it("round-trips frames after ten hours at fractional rates without accumulated stepping", () => {
    const rate = { numerator: 30000, denominator: 1001 };
    let frame = 1080000;
    for (let n = 0; n < 100000; n++) frame += 1;
    expect(toFrame(toSeconds(frame, rate), rate)).toBe(frame);
    expect(parseTimecode(timecode(frame, rate), rate)).toBe(frame);
    expect(parseTimecode("00:12:99:01", rate)).toBeNull();
    expect(parseTimecode("00:00:00:30", rate)).toBeNull();
  });
  it("maps client coordinates through the actual viewport origin", () => {
    expect(pointerFrame(437, 137, 1000, { start: 1000000, span: 1000 })).toBe(1000300);
    expect(pointerFrame(40, 137, 1000, { start: 1000000, span: 1000 })).toBe(1000000);
  });
  it("maps across multiple common gaps with the cut assigned to the next master frame", () => {
    const gaps = indexReviewGaps([{ start_frame: 50, end_frame: 250 }, { start_frame: 300, end_frame: 350 }]);
    expect([49, 50, 120, 250, 299, 350, 375].map(frame => toReviewFrame(frame, gaps)))
      .toEqual([49, 50, 50, 50, 99, 100, 125]);
    expect([49, 50, 99, 100, 125].map(frame => toMasterFrame(frame, gaps)))
      .toEqual([49, 250, 299, 350, 375]);
  });
  it("keeps the frame under the zoom anchor fixed and clamps the ends", () => {
    const view = { start: 1000000, span: 10000 }, anchor = 1007500;
    const next = zoomWindow(view, 2, anchor, 2000000, 50);
    expect((anchor - next.start) / next.span).toBe(0.75);
    expect(boundedWindow(-50, 1000, 2000000)).toEqual({ start: 0, span: 1000 });
    expect(boundedWindow(1999900, 1000, 2000000)).toEqual({ start: 1999000, span: 1000 });
  });
  it("windows long tracks without losing a long overlapping clip", () => {
    const clips = Array.from({ length: 3064 }, (_, n) => ({ timeline_start: n * 12, duration: n === 0 ? 20000 : 10, clip_id: String(n) } as MulticamSyncClip));
    const result = visibleClips(indexClips(clips), 15000, 15060);
    expect(result[0].clip_id).toBe("0");
    expect(result.length).toBeLessThan(8);
    expect(result).toEqual(clips.filter(c => c.timeline_start < 15060 && c.timeline_start + c.duration > 15000));
  });
});
