import { describe, expect, it } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import type { RoughCutPlan } from "../../api/production";
import { buildRoughCutTimelineProposal } from "./timelineSeed";

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
        effective_mapping: { source: "human", mapping_status: "confirmed", script_segment_ids: ["s1"], episode_ids: [1] },
        issues: [],
      },
    ],
    script_gaps: [],
    review_state: {},
  };
}

function plan(): RoughCutPlan {
  return {
    contract: "rough_cut_plan.v1",
    revision: "r1",
    project_id: "p1",
    coverage_revision: "c1",
    filters: {},
    readiness: "needs_review",
    summary: {},
    semantics: {},
    timebase: { status: "confirmed", source: "fcpxml_sequence", numerator: 24000, denominator: 1001 },
    scenes: [
      {
        scene_id: "scene1",
        episode: 1,
        heading: "",
        readiness: "needs_review",
        summary: {},
        segments: [
          {
            script: { segment_id: "s1", order: 1, type: "dialogue", speaker: "A", text: "hello" },
            selection_status: "explicit_best",
            primary_group_id: "g1",
            candidates: [
              {
                group_id: "g1",
                group_start: 0,
                group_end: 10,
                duration: 10,
                delivery_state: "best",
                decision_source: "editorial_decision",
                creative_authority: true,
                angles: [],
                continuity_risk: "low",
                audit_mapping_current: true,
                script_supervisor: { preferred_clip_id: "b", usable_range: { start: 2, end: 6 } },
                supervisor_blocked: false,
                supervisor_partial: true,
              },
            ],
            role_pools: {},
            summary: {},
            issues: [],
          },
          {
            script: { segment_id: "s2", order: 2, type: "dialogue", speaker: "B", text: "world" },
            selection_status: "needs_editorial_choice",
            primary_group_id: "",
            candidates: [],
            role_pools: {},
            summary: {},
            issues: [],
          },
        ],
      },
    ],
  };
}

const ntsc23976 = { numerator: 24000, denominator: 1001 };

describe("buildRoughCutTimelineProposal", () => {
  it("only converts explicit human Best rows and preserves skipped conflicts for review", () => {
    const result = buildRoughCutTimelineProposal(review(), plan(), ntsc23976);
    expect(result.commands).toHaveLength(1);
    expect(result.included).toHaveLength(1);
    expect(result.skipped).toEqual([
      { segmentId: "s2", status: "needs_editorial_choice", reason: "没有单一、显式的人工作品 Best，不自动进入 Timeline" },
    ]);
  });

  it("preserves 24000/1001 timebase while quantizing seconds to frames", () => {
    const result = buildRoughCutTimelineProposal(review(), plan(), ntsc23976);
    const command = result.commands[0];
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.source_in).toBe(Math.round(22 * 24000 / 1001));
    expect(command.clip.duration).toBe(Math.round(4 * 24000 / 1001));
    expect(command.clip.selected_angle_source_id).toBe("source:b");
    expect(command.clip.metadata.trim_basis).toBe("script_supervisor_usable_range");
    expect(command.clip.metadata.frame_rate).toBe("24000/1001");
    expect(result.baseProject.sequences[0].frame_rate).toEqual(ntsc23976);
    expect(result.baseProject.multicam_groups[0].angle_source_ids).toEqual(["source:a", "source:b"]);
  });

  it("does not auto-promote a non-explicit plan even when candidates exist", () => {
    const next = plan();
    next.scenes[0].segments[0].selection_status = "needs_editorial_choice";
    next.scenes[0].segments[0].primary_group_id = "";
    expect(buildRoughCutTimelineProposal(review(), next, { numerator: 25, denominator: 1 }).commands).toHaveLength(0);
  });

  it("fails closed when no valid timebase is supplied", () => {
    expect(() => buildRoughCutTimelineProposal(review(), plan(), { numerator: 0, denominator: 1 })).toThrow(
      "需要明确、有效的有理数时间基",
    );
  });
});
