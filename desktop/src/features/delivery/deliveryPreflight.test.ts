import { describe, expect, it } from "vitest";
import type { TimelineSnapshot } from "../../api/timeline";
import { buildTimelineDeliveryPreflight, sameTimelineAuthority } from "./deliveryPreflight";

function snapshot(): TimelineSnapshot {
  return {
    project: {
      version: 2,
      project_id: "p1",
      sources: [
        { source_id: "source:a", clip_id: "a", media_id: "ma", name: "A.mov", duration_frames: 1000 },
        { source_id: "source:b", clip_id: "b", media_id: "mb", name: "B.mov", duration_frames: 1000 },
      ],
      multicam_groups: [],
      sequences: [
        {
          sequence_id: "main",
          name: "Main",
          frame_rate: { numerator: 24000, denominator: 1001 },
          tracks: [
            {
              track_id: "V1",
              kind: "video",
              clips: [
                {
                  clip_id: "c1",
                  source_id: "source:a",
                  timeline_start: 0,
                  source_in: 100,
                  duration: 100,
                  enabled: true,
                  multicam_group_id: null,
                  selected_angle_source_id: null,
                  metadata: {},
                },
              ],
            },
            { track_id: "A1", kind: "audio", clips: [] },
          ],
          markers: [],
          transitions: [],
        },
      ],
      active_sequence_id: "main",
    },
    undo_depth: 0,
    redo_depth: 0,
    validation: [],
    authority: { generation: "g1", revision: 7 },
  };
}

function typedGroup() {
  return {
    group_id: "g1",
    angle_source_ids: ["source:a", "source:b"],
    angles: [
      { source_id: "source:a", camera: "A", name: "A.mov", sync_start_frame: 0, sync_end_frame: 1000 },
      { source_id: "source:b", camera: "B", name: "B.mov", sync_start_frame: 20, sync_end_frame: 1000 },
    ],
    reference_source_id: "source:a",
    audio_source_id: null,
  };
}

function blockerCodes(value: TimelineSnapshot): string[] {
  return buildTimelineDeliveryPreflight(value).blockers.map((item) => item.code);
}

describe("timeline delivery preflight", () => {
  it("allows a normalized v2 timeline with one video track", () => {
    const result = buildTimelineDeliveryPreflight(snapshot());
    expect(result.blockers).toEqual([]);
    expect(result.enabledVideoClipCount).toBe(1);
    expect(result.independentAudioClipCount).toBe(0);
  });

  it("blocks unresolved multicam angles before either NLE export", () => {
    const next = snapshot();
    const clip = next.project.sequences[0].tracks[0].clips[0];
    clip.multicam_group_id = "g1";
    next.project.multicam_groups = [typedGroup()];

    const result = buildTimelineDeliveryPreflight(next);
    expect(result.pendingMulticamCount).toBe(1);
    expect(result.blockers.some((item) => item.code === "multicam_angle_pending")).toBe(true);
  });

  it("allows independent audio while transitions remain an explicit blocker", () => {
    const next = snapshot();
    next.project.sequences[0].tracks[1].clips.push({
      ...next.project.sequences[0].tracks[0].clips[0],
      clip_id: "a1",
    });
    next.project.sequences[0].transitions.push({
      transition_id: "t1",
      track_id: "V1",
      left_clip_id: "c1",
      right_clip_id: "c2",
      duration: 8,
    });

    const result = buildTimelineDeliveryPreflight(next);
    expect(result.independentAudioClipCount).toBe(1);
    expect(result.blockers.map((item) => item.code)).not.toContain("independent_audio_unsupported");
    expect(result.blockers.map((item) => item.code)).toContain("transitions_unsupported");
    expect(result.warnings.map((item) => item.code)).toContain("independent_audio_preserved");
  });

  it("blocks legacy multicam groups that were not normalized to typed sync", () => {
    const next = snapshot();
    next.project.multicam_groups = [{ group_id: "g1", angle_source_ids: ["source:a", "source:b"] }];
    expect(blockerCodes(next)).toContain("multicam_typed_sync_missing");
  });

  it("blocks multiple non-empty video tracks and an empty final cut", () => {
    const next = snapshot();
    next.project.sequences[0].tracks[0].clips[0].enabled = false;
    next.project.sequences[0].tracks.push({
      track_id: "V2",
      kind: "video",
      clips: [{ ...next.project.sequences[0].tracks[0].clips[0], clip_id: "c2", source_id: "source:b" }],
    });

    expect(blockerCodes(next)).toEqual(expect.arrayContaining(["video_track_count", "no_enabled_video"]));
  });

  it("blocks overlapping clips on video or audio tracks instead of repairing them", () => {
    const next = snapshot();
    next.project.sequences[0].tracks[0].clips.push({
      ...next.project.sequences[0].tracks[0].clips[0],
      clip_id: "c2",
      source_id: "source:b",
      timeline_start: 50,
    });

    expect(blockerCodes(next)).toContain("track_overlap");
  });

  it("reports preserved multicam and format-specific marker behavior", () => {
    const next = snapshot();
    const clip = next.project.sequences[0].tracks[0].clips[0];
    clip.multicam_group_id = "g1";
    clip.selected_angle_source_id = "source:b";
    next.project.multicam_groups = [typedGroup()];
    next.project.sequences[0].markers.push({ marker_id: "m1", position: 12, label: "note" });

    const result = buildTimelineDeliveryPreflight(next);
    expect(result.blockers).toEqual([]);
    expect(result.warnings.map((item) => item.code)).toEqual(expect.arrayContaining([
      "multicam_preserved",
      "premiere_markers_omitted",
    ]));
    expect(result.warnings.map((item) => item.code)).not.toEqual(expect.arrayContaining([
      "multicam_flattened",
      "markers_omitted",
    ]));
  });

  it("carries Timeline Core validation into delivery readiness", () => {
    const next = snapshot();
    next.validation = [{ code: "bad_clip", path: "sequences[0]", message: "invalid clip" }];
    expect(blockerCodes(next)).toContain("timeline_validation");
  });

  it("compares current and delivered authority exactly", () => {
    expect(sameTimelineAuthority({ generation: "g1", revision: 7 }, { generation: "g1", revision: 7 })).toBe(true);
    expect(sameTimelineAuthority({ generation: "g1", revision: 8 }, { generation: "g1", revision: 7 })).toBe(false);
    expect(sameTimelineAuthority({ generation: "g2", revision: 7 }, { generation: "g1", revision: 7 })).toBe(false);
    expect(sameTimelineAuthority(null, { generation: "g1", revision: 7 })).toBe(false);
  });
});
