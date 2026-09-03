import { describe, expect, it } from "vitest";
import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { AssemblyTimeline } from "../../api/production";
import { buildAssemblyTimelineProposal } from "./timelineSeed";

function review(): ReviewModelPayload {
  return {
    contract_version: "review.v1",
    project: { project_id: "p1", name: "P1", input_kind: "fcpxml", stats: {}, local_media: {}, issues: [] },
    revisions: { analysis: "a1", automation_analysis: "a1", automation_updated_at: "", review: 2 },
    capabilities: {},
    summary: { automation: {}, script_gaps: 0, take_groups: 1, episodes: 1 },
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
        effective_mapping: { source: "human", mapping_status: "confirmed", script_segment_ids: ["s1", "s2"], episode_ids: [1] },
        issues: [],
      },
    ],
    script_gaps: [],
    review_state: {},
  };
}

function alternateTake(): ReviewTakeGroup {
  return {
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
    effective_mapping: { source: "human", mapping_status: "confirmed", script_segment_ids: ["s1"], episode_ids: [1] },
    issues: [],
  };
}

function assembly(): AssemblyTimeline {
  return {
    contract: "assembly_timeline.v2",
    revision: "ar1",
    rough_cut_plan_revision: "r1",
    project_id: "p1",
    coverage_revision: "c1",
    filters: {},
    readiness: "needs_review",
    duration: 4,
    summary: {},
    semantics: {
      desktop_reselects_take: false,
      desktop_reinterprets_usable_range: false,
      review_source_inventory_is_editorial_authority: false,
    },
    timebase: { status: "confirmed", source: "fcpxml_sequence", numerator: 24000, denominator: 1001 },
    scenes: [
      {
        scene_id: "scene1",
        episode: 1,
        heading: "",
        readiness: "needs_review",
        duration: 4,
        summary: {},
        blocks: [
          {
            block_id: "assembly:block1",
            kind: "source",
            script_segment_ids: ["s1", "s2"],
            selection_status: "explicit_best",
            decision_source: "editorial_decision",
            group_id: "g1",
            angle: {
              status: "manual_preferred",
              clip_id: "b",
              camera: "B",
              shot_type: "closeup",
              coverage_role: "dialogue",
              candidates: [
                { clip_id: "a", camera: "A", shot_type: "wide", coverage_role: "master" },
                { clip_id: "b", camera: "B", shot_type: "closeup", coverage_role: "dialogue" },
              ],
            },
            usable_range: { status: "manual", start: 2, end: 6, duration: 4, issues: [] },
            script_supervisor: { preferred_clip_id: "b", usable_range: { start: 2, end: 6 } },
            continuity_risk: "low",
            issues: [],
            assembly_status: "ready",
            timeline_start: 0,
            timeline_end: 4,
            duration: 4,
          },
          {
            block_id: "assembly:block2",
            kind: "unresolved",
            script_segment_ids: ["s3"],
            selection_status: "needs_editorial_choice",
            decision_source: "",
            group_id: "",
            angle: { status: "missing", clip_id: "", camera: "", shot_type: "unknown", coverage_role: "unknown", candidates: [] },
            usable_range: { status: "invalid", start: 0, end: 0, duration: 0, issues: [] },
            issues: [],
            assembly_status: "selection_pending",
            timeline_start: 4,
            timeline_end: 4,
          },
        ],
      },
    ],
  };
}

const ntsc23976 = { numerator: 24000, denominator: 1001 };

describe("buildAssemblyTimelineProposal", () => {
  it("projects Assembly blocks instead of re-evaluating per-script Best decisions", () => {
    const result = buildAssemblyTimelineProposal(review(), assembly(), ntsc23976);
    expect(result.commands).toHaveLength(1);
    expect(result.included).toHaveLength(1);
    expect(result.included[0].segmentIds).toEqual(["s1", "s2"]);
    expect(result.skipped).toEqual([
      { blockId: "assembly:block2", segmentId: "s3", status: "needs_editorial_choice", reason: "Assembly 未解析为单一显式 Best，保持人工待决" },
    ]);
  });

  it("keeps non-Best Review media in the source inventory without making it editorial authority", () => {
    const nextReview = review();
    nextReview.take_groups.push(alternateTake());
    nextReview.summary.take_groups = 2;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);

    expect(result.baseProject.sources.map((source) => source.source_id)).toEqual(["source:a", "source:b", "source:c"]);
    expect(result.commands).toHaveLength(1);
    expect(result.warnings.some((warning) => warning.includes("只提供媒体证据") && warning.includes("不参与 Best/范围决策"))).toBe(true);
  });

  it("uses the Assembly authoritative base angle but keeps the multicam edit angle unresolved", () => {
    const result = buildAssemblyTimelineProposal(review(), assembly(), ntsc23976);
    const command = result.commands[0];
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.multicam_group_id).toBe("g1");
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(command.clip.metadata.proposal_source).toBe("assembly_timeline.v2");
    expect(command.clip.metadata.assembly_block_id).toBe("assembly:block1");
    expect(command.clip.metadata.decision_source).toBe("editorial_decision");
  });

  it("uses the Assembly usable range and preserves 24000/1001 quantization", () => {
    const result = buildAssemblyTimelineProposal(review(), assembly(), ntsc23976);
    const command = result.commands[0];
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_in).toBe(Math.round(22 * 24000 / 1001));
    expect(command.clip.duration).toBe(Math.round(4 * 24000 / 1001));
    expect(command.clip.metadata.trim_basis).toBe("script_supervisor_usable_range");
    expect(command.clip.metadata.frame_rate).toBe("24000/1001");
    expect(result.baseProject.sequences[0].frame_rate).toEqual(ntsc23976);
  });

  it("fails closed if an Assembly-selected base angle is unavailable in local Review inventory", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles[1].playback.available = false;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);
    expect(result.commands).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("当前不可播放");
  });

  it("fails closed when no valid timebase is supplied", () => {
    expect(() => buildAssemblyTimelineProposal(review(), assembly(), { numerator: 0, denominator: 1 })).toThrow(
      "需要明确、有效的有理数时间基",
    );
  });
});
