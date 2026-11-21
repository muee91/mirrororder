// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
import { SyncTimelineViewport } from "./SyncTimelineViewport";

const rate = { numerator: 32, denominator: 1 };
const onSeek = vi.fn();
const onTogglePlay = vi.fn();
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  onSeek.mockClear();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

function makeTimeline(count: number): MulticamSyncTimeline {
  const clips = Array.from({ length: count }, (_, frame) => ({
    clip_id: String(frame), camera: "A", day: "1", name: `A-${frame}`,
    timeline_start: frame / 32, duration: 1 / 32, timecode: "", clip_number: "",
  }));
  return {
    project_id: "fixture", contract_version: "multicam_sync_timeline.v1", phase: "completed", ready: true,
    cameras: ["A"], task: null, message: "", duration_seconds: count / 32, clip_count: count,
    tracks: [{ track_id: "A", kind: "video", camera: "A", label: "A", clips, clip_count: count }],
  };
}

async function render(timeline: MulticamSyncTimeline, cursor: number, onOpenRecordings?: () => void) {
  await act(async () => root.render(<SyncTimelineViewport timeline={timeline} rate={rate} frameAccurate
    cursor={cursor} trackId="A" playing={false} canPlay onSeek={onSeek}
    onTogglePlay={onTogglePlay} onOpenRecordings={onOpenRecordings} />));
}

it("bounds dense tracks while preserving the active and keyboard-focused clip, and restores every clip at zoom", async () => {
  const timeline = makeTimeline(2235);
  timeline.tracks[0].clips[2000].duration = 12 / 32;
  await render(timeline, 3);
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-track-id=A] button")];
  expect(buttons().length).toBeLessThanOrEqual(300);
  expect(host.querySelector(".is-coalesced")).not.toBeNull();
  const longerClip = buttons().find(button => button.textContent === "A-2000")!;
  expect(longerClip.classList.contains("is-coalesced")).toBe(false);
  expect(parseFloat(longerClip.style.width)).toBeCloseTo(12 / 2235 * 100);
  const selected = host.querySelector<HTMLButtonElement>('[aria-pressed="true"]')!;
  expect(selected.textContent).toBe("A-3");
  expect(selected.classList.contains("is-coalesced")).toBe(false);
  await act(async () => selected.focus());
  await render(timeline, 4);
  expect(document.activeElement).toBe(selected);
  expect(selected.getAttribute("aria-pressed")).toBe("false");
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("A-4");
  await act(async () => selected.click());
  expect(onSeek).toHaveBeenCalledWith(3, "A");

  const zoom = host.querySelector<HTMLSelectElement>("#multicam-sync-zoom")!;
  await act(async () => {
    zoom.value = "16";
    zoom.dispatchEvent(new Event("change", { bubbles: true }));
  });
  const { viewStart, viewEnd } = host.querySelector<HTMLElement>(".sync-working-surface")!.dataset;
  const start = Number(viewStart), end = Number(viewEnd);
  expect(end - start).toBeLessThanOrEqual(260);
  expect(buttons().map(button => button.textContent)).toEqual(
    timeline.tracks[0].clips.slice(start, end).map(clip => clip.name),
  );
  expect(host.querySelector(".is-coalesced")).toBeNull();
});

it("caps alternating long and short clips and preserves the longest representative's keyboard target", async () => {
  const timeline = makeTimeline(480);
  let end = 0;
  for (const [index, clip] of timeline.tracks[0].clips.entries()) {
    clip.timeline_start = end / 32;
    const frames = index % 2 === 0 ? 1 : 8;
    clip.duration = frames / 32;
    end += frames;
  }
  timeline.duration_seconds = end / 32;
  await render(timeline, 0);
  const buttons = () => [...host.querySelectorAll<HTMLButtonElement>("[data-track-id=A] button")];
  expect(buttons().length).toBeLessThanOrEqual(300);
  // At frame 9 a one-frame clip precedes the eight-frame representative in the same bucket.
  const representative = buttons().find(button => button.textContent === "A-3")!;
  expect(representative.classList.contains("is-coalesced")).toBe(true);
  expect(parseFloat(representative.style.left)).toBeCloseTo(9 / end * 100);
  expect(parseFloat(representative.style.width)).toBeCloseTo(9 / end * 100);
  await act(async () => representative.focus());
  await render(timeline, 9);
  expect(document.activeElement).toBe(representative);
  expect(host.querySelector('[aria-pressed="true"]')?.textContent).toBe("A-2");
  expect(representative.classList.contains("is-coalesced")).toBe(false);
  expect(buttons().length).toBeLessThanOrEqual(300);
  await act(async () => representative.click());
  expect(onSeek).toHaveBeenCalledWith(10, "A");
});

it("keeps overlapping WAV placements selected until their respective end frames and activates the latest recording action", async () => {
  const timeline = makeTimeline(32);
  timeline.recordings = { candidate_count: 2, unplaced_count: 0, invalid_count: 0, placements: [
    { media_id: "a", name: "A.wav", at: 0, source: 0, frames: 10 },
    { media_id: "b", name: "B.wav", at: 2, source: 0, frames: 12 },
  ] };
  const selected = () => [...host.querySelectorAll(".is-wav-clip.is-selected")];
  const firstOpen = vi.fn(), latestOpen = vi.fn();
  await render(timeline, 2, firstOpen);
  const [a, b] = selected();
  expect([a.textContent, b.textContent]).toEqual(["A.wav", "B.wav"]);
  await render(timeline, 9, latestOpen);
  expect(selected()).toEqual([a, b]);
  await act(async () => (b as HTMLButtonElement).click());
  expect(onSeek).toHaveBeenCalledWith(2, undefined);
  expect(latestOpen).toHaveBeenCalledOnce();
  expect(firstOpen).not.toHaveBeenCalled();
  await render(timeline, 10, latestOpen);
  expect(selected()).toEqual([b]);
  await render(timeline, 14, latestOpen);
  expect(selected()).toHaveLength(0);
});
