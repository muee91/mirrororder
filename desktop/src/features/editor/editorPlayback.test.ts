import { describe, expect, it } from "vitest";
import type { TimelineProject, TimelineSequence } from "../../api/timeline";
import { activeSourceId, clampPlayhead, programMediaAtPlayhead, sequenceFps, videoClipAtPlayhead } from "./editorPlayback";
import { encodeMulticamSyncRanges, MULTICAM_SYNC_METADATA_KEY } from "./timelineSync";

function sequence(): TimelineSequence {
  const sync = encodeMulticamSyncRanges([
    { source_id: "source:a", start_frame: 100, end_frame: 300 },
    { source_id: "source:b", start_frame: 400, end_frame: 600 },
  ]);
  if (!sync) throw new Error("expected sync metadata");
  return {
    sequence_id: "main",
    name: "Main",
    frame_rate: { numerator: 25, denominator: 1 },
    tracks: [
      {
        track_id: "V1",
        kind: "video",
        clips: [
          {
            clip_id: "c1",
            source_id: "source:a",
            timeline_start: 10,
            source_in: 100,
            duration: 50,
            enabled: true,
            multicam_group_id: "g1",
            selected_angle_source_id: "source:b",
            metadata: { [MULTICAM_SYNC_METADATA_KEY]: sync },
          },
        ],
      },
    ],
    markers: [],
    transitions: [],
  };
}

function project(): TimelineProject {
  return {
    version: 1,
    project_id: "p1",
    sources: [
      { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A", duration_frames: 1000 },
      { source_id: "source:b", clip_id: "b", media_id: "mb", name: "B", duration_frames: 1000 },
    ],
    multicam_groups: [{ group_id: "g1", angle_source_ids: ["source:a", "source:b"] }],
    sequences: [sequence()],
    active_sequence_id: "main",
  };
}

describe("editor playback mapping", () => {
  it("uses the rational sequence frame rate", () => {
    expect(sequenceFps({ ...sequence(), frame_rate: { numerator: 30000, denominator: 1001 } })).toBeCloseTo(29.970, 2);
  });

  it("rebases the selected multicam angle using Rust-persisted clip metadata", () => {
    const value = programMediaAtPlayhead(project(), sequence(), 20);
    expect(value?.source.clip_id).toBe("b");
    expect(value?.sourceFrame).toBe(410);
    expect(value?.sourceSeconds).toBeCloseTo(16.4);
  });

  it("fails closed when a switched multicam clip lacks synchronization metadata", () => {
    const next = sequence();
    delete next.tracks[0].clips[0].metadata[MULTICAM_SYNC_METADATA_KEY];
    expect(programMediaAtPlayhead(project(), next, 20)).toBeNull();
  });

  it("does not show a disabled clip in Program Monitor", () => {
    const next = sequence();
    next.tracks[0].clips[0].enabled = false;
    expect(videoClipAtPlayhead(next, 20)).toBeNull();
  });

  it("keeps the playhead within the sequence extent", () => {
    expect(clampPlayhead(sequence(), -20)).toBe(0);
    expect(clampPlayhead(sequence(), 999)).toBe(60);
  });

  it("does not present the base source as an editorial multicam choice", () => {
    const nextSequence = sequence();
    const clip = nextSequence.tracks[0].clips[0];
    clip.selected_angle_source_id = null;
    expect(activeSourceId(clip)).toBeNull();
    expect(programMediaAtPlayhead(project(), nextSequence, 20)).toBeNull();
  });

  it("still uses the base source for an ordinary single-source clip", () => {
    const nextSequence = sequence();
    const clip = nextSequence.tracks[0].clips[0];
    clip.multicam_group_id = null;
    clip.selected_angle_source_id = null;
    expect(activeSourceId(clip)).toBe("source:a");
    expect(programMediaAtPlayhead(project(), nextSequence, 20)?.sourceFrame).toBe(110);
  });
});
