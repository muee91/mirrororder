import { describe, expect, it } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import type { TimelineProject, TimelineSnapshot } from "../../api/timeline";
import {
  buildManualSourceCommand,
  buildReplaceTakeCommand,
  buildTimelineSourceOptions,
  insertCutsExistingClip,
  validateManualSourceRange,
  validateReplaceTakeRange,
} from "./timelineSourceEditing";

function review(): ReviewModelPayload {
  return {
    contract_version: "review.v1",
    project: { project_id: "p1", name: "P1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
    revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 1 },
    capabilities: {},
    summary: { automation: {}, script_gaps: 0, take_groups: 2, episodes: 1 },
    episodes: [],
    take_groups: [
      {
        group_id: "g1",
        parent_group_id: "",
        kind: "multicam",
        take_index: 1,
        split_reason: "",
        start: 0,
        end: 10,
        duration: 10,
        cameras: ["A", "B"],
        angles: [
          { clip_id: "a", media_id: "ma", camera: "A", name: "A.mov", timeline_start: 0, timeline_end: 10, duration: 10, source_start: 5, source_end: 15, playback: { url: "", source_start: 5, source_end: 15, available: true } },
          { clip_id: "b", media_id: "mb", camera: "B", name: "B.mov", timeline_start: 0, timeline_end: 10, duration: 10, source_start: 20, source_end: 30, playback: { url: "", source_start: 20, source_end: 30, available: true } },
        ],
        transcript: { text: "", source: "none" },
        people: { faces: [], speakers: [] },
        candidates: [],
        context: { episode_ids: [], script_segment_ids: [] },
        automatic_state: {},
        editorial_state: {},
        effective_mapping: { source: "human", mapping_status: "confirmed", script_segment_ids: [], episode_ids: [] },
        issues: [],
      },
      {
        group_id: "g2",
        parent_group_id: "",
        kind: "single",
        take_index: 2,
        split_reason: "",
        start: 0,
        end: 8,
        duration: 8,
        cameras: ["A"],
        angles: [
          { clip_id: "c", media_id: "mc", camera: "A", name: "C.mov", timeline_start: 0, timeline_end: 8, duration: 8, source_start: 40, source_end: 48, playback: { url: "", source_start: 40, source_end: 48, available: true } },
        ],
        transcript: { text: "", source: "none" },
        people: { faces: [], speakers: [] },
        candidates: [],
        context: { episode_ids: [], script_segment_ids: [] },
        automatic_state: {},
        editorial_state: {},
        effective_mapping: { source: "human", mapping_status: "confirmed", script_segment_ids: [], episode_ids: [] },
        issues: [],
      },
    ],
    script_gaps: [],
    review_state: {},
  };
}

function project(): TimelineProject {
  return {
    version: 2,
    project_id: "p1",
    sources: [
      { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 360 },
      { source_id: "source:b", clip_id: "b", media_id: "mb", name: "B.mov", duration_frames: 720 },
      { source_id: "source:c", clip_id: "c", media_id: "mc", name: "C.mov", duration_frames: 1152 },
    ],
    multicam_groups: [{
      group_id: "g1",
      angle_source_ids: ["source:a", "source:b"],
      reference_source_id: "source:a",
      audio_source_id: null,
      angles: [
        { source_id: "source:a", camera: "A", name: "A.mov", sync_start_frame: 120, sync_end_frame: 360 },
        { source_id: "source:b", camera: "B", name: "B.mov", sync_start_frame: 480, sync_end_frame: 720 },
      ],
    }],
    sequences: [{
      sequence_id: "main",
      name: "Main",
      frame_rate: { numerator: 24, denominator: 1 },
      tracks: [{
        track_id: "V1",
        kind: "video",
        clips: [{
          clip_id: "existing",
          source_id: "source:a",
          timeline_start: 0,
          source_in: 120,
          duration: 120,
          enabled: true,
          multicam_group_id: "g1",
          selected_angle_source_id: "source:a",
          metadata: { group_id: "g1", segment_id: "s1", trim_basis: "script_supervisor_usable_range" },
        }],
      }],
      markers: [],
      transitions: [],
    }],
    active_sequence_id: "main",
  };
}

function snapshot(): TimelineSnapshot {
  return {
    project: project(),
    undo_depth: 2,
    redo_depth: 0,
    validation: [],
    authority: { generation: "g1", revision: 7 },
  };
}

describe("timeline source editing", () => {
  it("derives source ranges from Review evidence without turning them into timeline clips", () => {
    const value = project();
    const sequence = value.sequences[0];
    const options = buildTimelineSourceOptions(review(), value, sequence);
    expect(options).toHaveLength(3);
    expect(options[0]).toMatchObject({
      groupId: "g1",
      camera: "A",
      availableIn: 120,
      availableDuration: 240,
      multicamGroupId: "g1",
    });
    expect(options[1]).toMatchObject({ availableIn: 480, availableDuration: 240 });
    expect(options[2]).toMatchObject({ groupId: "g2", availableIn: 960, availableDuration: 192, multicamGroupId: null });
  });

  it("requires current playable Review evidence even when an older Timeline checkpoint still contains the source", () => {
    const value = project();
    const currentReview = review();
    currentReview.take_groups[0].angles[1].playback.available = false;
    const options = buildTimelineSourceOptions(currentReview, value, value.sequences[0]);
    expect(options.map((option) => option.source.source_id)).toEqual(["source:a", "source:c"]);
    expect(buildTimelineSourceOptions(null, value, value.sequences[0])).toEqual([]);
  });

  it("intersects current Review evidence with persisted media duration", () => {
    const value = project();
    value.sources[1].duration_frames = 500;
    const options = buildTimelineSourceOptions(review(), value, value.sequences[0]);
    expect(options[1]).toMatchObject({ availableIn: 480, availableDuration: 20 });
    expect(validateManualSourceRange(options[1], 480, 20)).toBeNull();
    expect(validateManualSourceRange(options[1], 480, 21)).toContain("可用 Source");

    value.sources[1].duration_frames = 480;
    expect(buildTimelineSourceOptions(review(), value, value.sequences[0]).map((option) => option.source.source_id)).toEqual(["source:a", "source:c"]);
  });

  it("rejects manual ranges outside Review evidence", () => {
    const value = project();
    const option = buildTimelineSourceOptions(review(), value, value.sequences[0])[0];
    expect(validateManualSourceRange(option, 120, 24)).toBeNull();
    expect(validateManualSourceRange(option, 119, 24)).toContain("可用 Source");
    expect(validateManualSourceRange(option, 350, 24)).toContain("可用 Source");
  });

  it("builds human Insert/Overwrite commands with multicam identity and no legacy sync metadata", () => {
    const value = snapshot();
    const sequence = value.project.sequences[0];
    const option = buildTimelineSourceOptions(review(), value.project, sequence)[1];
    const command = buildManualSourceCommand("overwrite", value, sequence, option, 480, 48, 36);
    expect(command.type).toBe("overwrite");
    if (command.type !== "overwrite") throw new Error("expected overwrite");
    expect(command.track_id).toBe("V1");
    expect(command.clip).toMatchObject({
      source_id: "source:b",
      timeline_start: 36,
      source_in: 480,
      duration: 48,
      multicam_group_id: "g1",
      selected_angle_source_id: "source:b",
    });
    expect(command.clip.clip_id).toContain("manual:overwrite:g1:8:36:");
    expect(command.clip.metadata).toMatchObject({
      edit_source: "human_source_monitor",
      edit_mode: "overwrite",
      group_id: "g1",
      camera: "B",
    });
    expect(command.clip.metadata.multicam_sync_v1).toBeUndefined();
  });

  it("builds ReplaceTake as a semantic edit that preserves the selected clip duration", () => {
    const value = project();
    const sequence = value.sequences[0];
    const selected = sequence.tracks[0].clips[0];
    const option = buildTimelineSourceOptions(review(), value, sequence)[2];
    expect(validateReplaceTakeRange(option, selected, 960)).toBeNull();
    expect(buildReplaceTakeCommand(sequence, selected, option, 960)).toEqual({
      type: "replace_take",
      sequence_id: "main",
      clip_id: "existing",
      group_id: "g2",
      source_id: "source:c",
      source_in: 960,
    });
  });

  it("fails ReplaceTake preflight when the replacement cannot cover the current edit duration", () => {
    const value = project();
    const sequence = value.sequences[0];
    const selected = sequence.tracks[0].clips[0];
    const option = buildTimelineSourceOptions(review(), value, sequence)[2];
    expect(validateReplaceTakeRange(option, selected, 1100)).toContain("可用 Source");
  });

  it("preflights Insert positions that cut through an existing video clip", () => {
    const sequence = project().sequences[0];
    expect(insertCutsExistingClip(sequence, 0)).toBe(false);
    expect(insertCutsExistingClip(sequence, 60)).toBe(true);
    expect(insertCutsExistingClip(sequence, 120)).toBe(false);
    expect(insertCutsExistingClip(sequence, 240)).toBe(false);
  });
});
