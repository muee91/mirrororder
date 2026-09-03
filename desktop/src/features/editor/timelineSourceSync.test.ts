import { describe, expect, it } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import type { AssemblyTimeline } from "../../api/production";
import { buildAssemblyTimelineProposal } from "./timelineSeed";

function review(): ReviewModelPayload {
  return {
    project: { project_id: "p1" },
    take_groups: [{
      group_id: "g1",
      duration: 10,
      angles: [
        { clip_id: "a", media_id: "ma", camera: "A", name: "A.mov", source_start: 5, source_end: 15, duration: 10, playback: { available: true } },
        { clip_id: "b", media_id: "mb", camera: "B", name: "B.mov", source_start: 20, source_end: 30, duration: 10, playback: { available: true } },
      ],
    }],
  } as unknown as ReviewModelPayload;
}

function assembly(): AssemblyTimeline {
  return {
    contract: "assembly_timeline.v2",
    revision: "a1",
    project_id: "p1",
    scenes: [{
      scene_id: "scene1",
      episode: 1,
      blocks: [{
        block_id: "block1",
        kind: "source",
        script_segment_ids: ["s1"],
        selection_status: "explicit_best",
        decision_source: "editorial_decision",
        group_id: "g1",
        angle: { clip_id: "a" },
        usable_range: { status: "manual", start: 0, end: 4 },
        assembly_status: "ready",
      }],
    }],
  } as unknown as AssemblyTimeline;
}

describe("Timeline source synchronization seed", () => {
  it("persists Review angle ranges as typed Timeline v2 multicam angles", () => {
    const result = buildAssemblyTimelineProposal(review(), assembly(), { numerator: 24, denominator: 1 });
    expect(result.baseProject.version).toBe(2);
    expect(result.baseProject.sources).toEqual([
      { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 360 },
      { source_id: "source:b", clip_id: "b", media_id: "mb", name: "B.mov", duration_frames: 720 },
    ]);
    expect(result.baseProject.multicam_groups[0]).toEqual({
      group_id: "g1",
      angle_source_ids: ["source:a", "source:b"],
      reference_source_id: "source:a",
      audio_source_id: null,
      angles: [
        { source_id: "source:a", camera: "A", name: "A.mov", sync_start_frame: 120, sync_end_frame: 360 },
        { source_id: "source:b", camera: "B", name: "B.mov", sync_start_frame: 480, sync_end_frame: 720 },
      ],
    });
    const command = result.commands[0];
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.metadata.multicam_sync_v1).toBeUndefined();
  });
});
