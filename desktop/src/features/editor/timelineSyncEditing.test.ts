import { describe, expect, it } from "vitest";
import type { TimelineSequence, TimelineSnapshot } from "../../api/timeline";
import { buildManualSourceCommand, type TimelineSourceOption } from "./timelineSourceEditing";

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

describe("manual source synchronization semantics", () => {
  it("does not copy legacy sync JSON into newly inserted Timeline clips", () => {
    const option: TimelineSourceOption = {
      source: { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 360 },
      groupId: "g1",
      camera: "A",
      availableIn: 120,
      availableDuration: 240,
      multicamGroupId: "g1",
      label: "A.mov",
    };
    const snapshot = {
      authority: { generation: "g1", revision: 3 },
    } as unknown as TimelineSnapshot;
    const command = buildManualSourceCommand("insert", snapshot, sequence(), option, 120, 48, 0);
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.metadata.multicam_sync_v1).toBeUndefined();
    expect(command.clip.multicam_group_id).toBe("g1");
    expect(command.clip.selected_angle_source_id).toBe("source:a");
  });
});
