import { describe, expect, it } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import type { RoughCutPlan } from "../../api/production";
import { buildRoughCutTimelineProposal } from "./timelineSeed";
import { decodeMulticamSyncRanges, MULTICAM_SYNC_METADATA_KEY } from "./timelineSync";

function review(): ReviewModelPayload {
  return {
    project: { project_id: "p1" },
    take_groups: [{
      group_id: "g1",
      duration: 10,
      angles: [
        { clip_id: "a", media_id: "ma", name: "A.mov", source_start: 5, source_end: 15, duration: 10, playback: { available: true } },
        { clip_id: "b", media_id: "mb", name: "B.mov", source_start: 20, source_end: 30, duration: 10, playback: { available: true } },
      ],
    }],
  } as unknown as ReviewModelPayload;
}

function plan(): RoughCutPlan {
  return {
    contract: "rough_cut_plan.v1",
    revision: "r1",
    project_id: "p1",
    scenes: [{
      segments: [{
        script: { segment_id: "s1" },
        selection_status: "explicit_best",
        primary_group_id: "g1",
        candidates: [{ group_id: "g1", script_supervisor: { preferred_clip_id: "a" } }],
      }],
    }],
  } as unknown as RoughCutPlan;
}

describe("Timeline source synchronization seed", () => {
  it("persists Review angle source ranges inside Rust-owned clip metadata", () => {
    const result = buildRoughCutTimelineProposal(review(), plan(), { numerator: 24, denominator: 1 });
    expect(result.baseProject.sources).toEqual([
      { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 360 },
      { source_id: "source:b", clip_id: "b", media_id: "mb", name: "B.mov", duration_frames: 720 },
    ]);
    const command = result.commands[0];
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    const ranges = decodeMulticamSyncRanges(command.clip.metadata[MULTICAM_SYNC_METADATA_KEY]);
    expect(ranges?.get("source:a")).toEqual({ source_id: "source:a", start_frame: 120, end_frame: 360 });
    expect(ranges?.get("source:b")).toEqual({ source_id: "source:b", start_frame: 480, end_frame: 720 });
  });
});
