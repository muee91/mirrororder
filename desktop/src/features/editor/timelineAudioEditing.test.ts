import { describe, expect, it } from "vitest";
import type { TimelineSequence, TimelineSnapshot } from "../../api/timeline";
import { audioInsertCutsExistingClip, buildManualAudioCommand } from "./timelineAudioEditing";
import type { TimelineSourceOption } from "./timelineSourceEditing";

function sequence(): TimelineSequence {
  return {
    sequence_id: "main",
    name: "Main",
    frame_rate: { numerator: 24, denominator: 1 },
    tracks: [
      { track_id: "V1", kind: "video", clips: [] },
      {
        track_id: "A1",
        kind: "audio",
        clips: [{
          clip_id: "old-audio",
          source_id: "source:a",
          timeline_start: 20,
          source_in: 100,
          duration: 20,
          enabled: true,
          multicam_group_id: null,
          selected_angle_source_id: null,
          metadata: { media_component: "audio" },
        }],
      },
    ],
    markers: [],
    transitions: [],
  };
}

function option(): TimelineSourceOption {
  return {
    source: { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 500 },
    groupId: "g1",
    camera: "A",
    availableIn: 100,
    availableDuration: 100,
    multicamGroupId: "g1",
    label: "A.mov",
  };
}

describe("manual Timeline audio editing", () => {
  it("creates a standard Rust Timeline command on A1 without multicam source switching", () => {
    const snapshot = { authority: { generation: "g1", revision: 3 } } as unknown as TimelineSnapshot;
    const command = buildManualAudioCommand("overwrite", snapshot, sequence(), option(), 110, 30, 50);
    expect(command.type).toBe("overwrite");
    if (command.type !== "overwrite") throw new Error("expected overwrite");
    expect(command.track_id).toBe("A1");
    expect(command.clip.source_id).toBe("source:a");
    expect(command.clip.multicam_group_id).toBeNull();
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(command.clip.metadata.media_component).toBe("audio");
    expect(command.clip.metadata.group_id).toBe("g1");
  });

  it("detects Insert positions that cut an existing A1 clip", () => {
    expect(audioInsertCutsExistingClip(sequence(), 30)).toBe(true);
    expect(audioInsertCutsExistingClip(sequence(), 20)).toBe(false);
    expect(audioInsertCutsExistingClip(sequence(), 40)).toBe(false);
  });

  it("fails closed when the authoritative Timeline has no audio track", () => {
    const next = sequence();
    next.tracks = next.tracks.filter((track) => track.kind !== "audio");
    const snapshot = { authority: { generation: "g1", revision: 3 } } as unknown as TimelineSnapshot;
    expect(() => buildManualAudioCommand("insert", snapshot, next, option(), 110, 30, 50)).toThrow("没有独立音频轨");
  });
});
