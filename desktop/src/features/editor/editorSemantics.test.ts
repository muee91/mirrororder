import { describe, expect, it } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import type { AssemblyTimeline, SlateBoard } from "../../api/production";
import type { TimelineProject, TimelineSequence } from "../../api/timeline";
import { buildEditorialInspector, buildEditorialSuggestions, buildReplacementTakeOptions } from "./editorSemantics";
import { buildTimelineSourceOptions } from "./timelineSourceEditing";

function review(): ReviewModelPayload {
  const take = (group_id: string, take_index: number, clip_id: string, camera: string) => ({
    group_id, parent_group_id: "", kind: "single", take_index, split_reason: "", start: 0, end: 8, duration: 8,
    cameras: [camera],
    angles: [{ clip_id, media_id: `m-${clip_id}`, camera, name: `${clip_id}.mov`, timeline_start: 0, timeline_end: 8, duration: 8, source_start: 0, source_end: 8, playback: { url: "", source_start: 0, source_end: 8, available: true } }],
    transcript: { text: "", source: "none" }, people: { faces: [], speakers: [] }, candidates: [],
    context: { episode_ids: [1], script_segment_ids: ["s1"] }, automatic_state: {}, editorial_state: {},
    effective_mapping: { source: "human", mapping_status: "confirmed", script_segment_ids: ["s1"], episode_ids: [1] }, issues: [],
  });
  return {
    contract_version: "review.v1",
    project: { project_id: "p1", name: "P1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
    revisions: { analysis: "a", automation_analysis: "a", automation_updated_at: "", review: 1 },
    capabilities: {}, summary: { automation: {}, script_gaps: 1, take_groups: 3, episodes: 1 }, episodes: [],
    take_groups: [take("g1", 1, "a", "A"), take("g2", 2, "b", "B"), take("g3", 3, "c", "A")],
    script_gaps: [], review_state: {},
  };
}

function board(): SlateBoard {
  return {
    version: 2, contract: "script_supervisor.v2", revision: 3, updated_at: "", records: {}, semantics: {},
    entries: {
      g1: { group_id: "g1", script_scene_id: "scene12", episode: 1, scene: "12", shot: "2B", take_number: 1, status: "usable", note: "表演稳定", preferred_clip_id: "a", angles: {}, actor: "u", updated_at: "", usable_range: { start: 1, end: 6 } },
      g2: { group_id: "g2", script_scene_id: "scene12", episode: 1, scene: "12", shot: "2B", take_number: 2, status: "ng", note: "穿帮", preferred_clip_id: "b", angles: {}, actor: "u", updated_at: "" },
      g3: { group_id: "g3", script_scene_id: "scene12", episode: 1, scene: "12", shot: "2B", take_number: 3, status: "usable", note: "可替换", preferred_clip_id: "c", angles: {}, actor: "u", updated_at: "", usable_range: { start: 0, end: 7 } },
    },
  };
}

function project(): TimelineProject {
  return {
    version: 2, project_id: "p1",
    sources: [
      { source_id: "source:a", clip_id: "a", media_id: "ma", name: "a.mov", duration_frames: 192 },
      { source_id: "source:b", clip_id: "b", media_id: "mb", name: "b.mov", duration_frames: 192 },
      { source_id: "source:c", clip_id: "c", media_id: "mc", name: "c.mov", duration_frames: 192 },
    ],
    multicam_groups: [],
    sequences: [{
      sequence_id: "main", name: "剪辑", frame_rate: { numerator: 24, denominator: 1 },
      tracks: [{ track_id: "V1", kind: "video", clips: [{
        clip_id: "clip1", source_id: "source:a", timeline_start: 0, source_in: 24, duration: 72, enabled: true,
        multicam_group_id: null, selected_angle_source_id: null,
        metadata: { group_id: "g1", segment_id: "s1", script_segment_ids: "[\"s1\"]", decision_source: "editorial_decision", trim_basis: "script_supervisor_usable_range" },
      }] }], markers: [], transitions: [],
    }], active_sequence_id: "main",
  };
}

function assembly(): AssemblyTimeline {
  return {
    contract: "assembly_timeline.v2", revision: "r", rough_cut_plan_revision: "r0", coverage_revision: "c", project_id: "p1", filters: {},
    readiness: "ready", duration: 3, summary: {}, semantics: {}, scenes: [{
      scene_id: "scene12", episode: 1, heading: "", readiness: "ready", duration: 3, summary: {}, blocks: [{
        block_id: "b1", kind: "source", script_segment_ids: ["s1"], selection_status: "explicit_best", decision_source: "editorial_decision",
        group_id: "g1", angle: {}, usable_range: { status: "manual", start: 1, end: 6, duration: 5, issues: [] }, issues: [], assembly_status: "ready",
        timeline_start: 0, timeline_end: 3, continuity_risk: "high",
      }],
    }],
  };
}

describe("editorial timeline semantics", () => {
  it("presents clip identity in production language instead of source ids", () => {
    const p = project();
    const clip = p.sequences[0].tracks[0].clips[0];
    const model = buildEditorialInspector(review(), board(), p, clip);
    expect(model.title).toBe("第 12 场 · 2B 镜 · 第 1 条");
    expect(model.subtitle).toContain("A 机");
    expect(model.identity.note).toBe("表演稳定");
    expect(model.decisionSource).toBe("editorial_decision");
  });

  it("offers same-shot replacement takes and blocks NG candidates", () => {
    const p = project();
    const sequence = p.sequences[0] as TimelineSequence;
    const clip = sequence.tracks[0].clips[0];
    const options = buildTimelineSourceOptions(review(), p, sequence);
    const replacements = buildReplacementTakeOptions(review(), board(), sequence, clip, options);
    expect(replacements.map((item) => item.groupId)).toEqual(["g3", "g2"]);
    expect(replacements[0].blockedReason).toBeNull();
    expect(replacements[1].blockedReason).toBe("场记标记为 NG");
  });

  it("keeps suggestions proposal-only and surfaces coverage/continuity issues", () => {
    const p = project();
    p.sequences[0].tracks[0].clips[0].metadata.assembly_block_id = "b1";
    const suggestions = buildEditorialSuggestions(review(), board(), assembly(), p, p.sequences[0]);
    expect(suggestions.map((item) => item.kind)).toEqual(expect.arrayContaining(["coverage", "continuity"]));
    expect(suggestions.every((item) => !(item as unknown as { command?: unknown }).command)).toBe(true);
  });
});
