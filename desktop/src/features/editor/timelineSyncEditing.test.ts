import { describe, expect, it } from "vitest";
import type { TimelineSequence, TimelineSnapshot } from "../../api/timeline";
import { buildManualSourceCommand, type TimelineSourceOption } from "./timelineSourceEditing";
import { encodeMulticamSyncRanges, MULTICAM_SYNC_METADATA_KEY } from "./timelineSync";

function sequence(): TimelineSequence {
  return {
    sequence_id: "main",
    name: "Main",
    frame_rate: { numerator: 24, denominator: 1 },
    tracks: [{ track_id: "V1", kind: "video", clips: [] }],
    markers: [],
    transitions: [],
  };
}

describe("manual source synchronization metadata", () => {
  it("copies multicam synchronization evidence into the authoritative inserted clip", () => {
    const sync = encodeMulticamSyncRanges([
      { source_id: "source:a", start_frame: 120, end_frame: 360 },
      { source_id: "source:b", start_frame: 480, end_frame: 720 },
    ]);
    if (!sync) throw new Error("expected sync metadata");
    const option: TimelineSourceOption = {
      source: { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 360 },
      groupId: "g1",
      camera: "A",
      availableIn: 120,
      availableDuration: 240,
      multicamGroupId: "g1",
      syncMetadata: sync,
      label: "A.mov",
    };
    const snapshot = {
      authority: { generation: "g1", revision: 3 },
    } as unknown as TimelineSnapshot;
    const command = buildManualSourceCommand("insert", snapshot, sequence(), option, 120, 48, 0);
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.metadata[MULTICAM_SYNC_METADATA_KEY]).toBe(sync);
    expect(command.clip.multicam_group_id).toBe("g1");
    expect(command.clip.selected_angle_source_id).toBe("source:a");
  });
});
