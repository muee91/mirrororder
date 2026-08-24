import { describe, expect, it } from "vitest";
import type { TimelineProject, TimelineSequence } from "../../api/timeline";
import { activeSourceId, clampPlayhead, programMediaAtPlayhead, sequenceFps, videoClipAtPlayhead } from "./editorPlayback";

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

function sequence(): TimelineSequence {
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
            metadata: {},
          },
        ],
      },
    ],
    markers: [],
    transitions: [],
  };
}

describe("editor playback mapping", () => {
  it("uses the rational sequence frame rate", () => {
    expect(sequenceFps({ ...sequence(), frame_rate: { numerator: 30000, denominator: 1001 } })).toBeCloseTo(29.970, 2);
  });

  it("resolves the selected multicam angle for Program Monitor", () => {
    const value = programMediaAtPlayhead(project(), sequence(), 20);
    expect(value?.source.clip_id).toBe("b");
    expect(value?.sourceFrame).toBe(110);
    expect(value?.sourceSeconds).toBeCloseTo(4.4);
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

  it("uses base source when no multicam selection is active", () => {
    const clip = sequence().tracks[0].clips[0];
    clip.selected_angle_source_id = null;
    expect(activeSourceId(clip)).toBe("source:a");
  });
});
