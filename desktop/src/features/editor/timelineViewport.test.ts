import { describe, expect, it } from "vitest";
import { boundedWindow, framePosition, navigationKey, pointerFrame, revealFrame, rulerTicks, zoomWindow } from "./timelineViewport";
import { bindTimelineViewportInput } from "./timelineViewportInput";
import { bindSyncTimelineViewportInput } from "./syncTimelineViewportInput";
const key = (key: string, extra = {}) => ({ key, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...extra });
describe("shared view-only timeline foundation", () => {
  it("uses the same gesture implementation for both modes", () => {
    expect(bindSyncTimelineViewportInput).toBe(bindTimelineViewportInput);
  });
  it("keeps integer frames anchored at long positions through zoom and resize", () => {
    const view = { start: 1000000, span: 10000 };
    const anchor = pointerFrame(850, 100, 1000, view);
    const next = zoomWindow(view, 2, anchor, 2000000, 50);
    expect(framePosition(anchor, next)).toBe(0.75);
    expect(pointerFrame(400, 100, 400, next)).toBe(anchor);
    expect(boundedWindow(1999999, 1000, 2000000).start).toBe(1999000);
  });
  it("keeps the cursor visible without recentering on every frame", () => {
    const view = { start: 100, span: 50 };
    expect(revealFrame(120, view, 1000)).toEqual(view);
    expect(revealFrame(150, view, 1000)).toEqual({start:125, span:50});
    expect(revealFrame(999, view, 1000)).toEqual({start:950, span:50});
  });
  it("generates integral bounded ticks for narrow and wide viewports", () => {
    for (const width of [320, 800, 1920]) {
      const ticks = rulerTicks({ start: 1000013, span: 10000 }, width);
      expect(ticks.length).toBeLessThanOrEqual(Math.ceil(width / 150) + 1);
      expect(ticks.every(n => Number.isInteger(n) && n >= 1000013 && n <= 1010013)).toBe(true);
    }
  });
  it("steps the cursor, never emits edit commands, and respects unknown timebase", () => {
    expect(navigationKey(key("ArrowRight"), 100, 1000)).toEqual({ type:"seek", frame:101 });
    expect(navigationKey(key("ArrowLeft", {shiftKey:true}), 5, 1000)).toEqual({type:"seek",frame:0});
    expect(navigationKey(key("ArrowRight"), 999, 1000)).toEqual({type:"seek",frame:999});
    expect(navigationKey(key("ArrowRight"), 100, 1000, false)).toBeNull();
    expect(navigationKey(key("ArrowRight", {metaKey:true}), 100, 1000)).toBeNull();
    expect(navigationKey(key("Delete"), 100, 1000)).toBeNull();
    expect(navigationKey(key("z", {metaKey:true}), 100, 1000)).toBeNull();
  });
});
