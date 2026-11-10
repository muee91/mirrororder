import { describe, expect, it } from "vitest";
import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { AssemblyTimeline } from "../../api/production";
import type { TimelineSnapshot } from "../../api/timeline";
import { buildTimelineDeliveryPreflight } from "../delivery/deliveryPreflight";
import { programMediaAtPlayhead } from "./editorPlayback";
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

function proposalSnapshot(result: ReturnType<typeof buildAssemblyTimelineProposal>): TimelineSnapshot {
  const project = structuredClone(result.baseProject);
  for (const command of result.commands) {
    if (command.type !== "insert") throw new Error("expected insert");
    project.sequences.find((sequence) => sequence.sequence_id === command.sequence_id)!
      .tracks.find((track) => track.track_id === command.track_id)!.clips.push(command.clip);
  }
  return { project, undo_depth: 0, redo_depth: 0, validation: [], authority: { generation: "test", revision: 1 } };
}

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

  it("carries the Assembly manual preference into the proposal without requiring another angle choice", () => {
    const result = buildAssemblyTimelineProposal(review(), assembly(), ntsc23976);
    const command = result.commands[0];
    expect(command.type).toBe("insert");
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.multicam_group_id).toBe("g1");
    expect(command.clip.selected_angle_source_id).toBe("source:b");
    expect(command.clip.metadata.proposal_source).toBe("assembly_timeline.v2");
    expect(command.clip.metadata.assembly_block_id).toBe("assembly:block1");
    expect(command.clip.metadata.decision_source).toBe("editorial_decision");
    expect(command.clip.metadata.angle_selection_status).toBe("manual_preferred");
    expect(result.warnings.some((warning) => warning.includes("机位保持待选"))).toBe(false);
    expect(result.warnings.some((warning) => warning.includes("沿用场记人工首选机位"))).toBe(true);

    // The seed itself does not mutate Timeline authority. Exercise the existing
    // playback/delivery projections against its proposed insert payload.
    expect(result.baseProject.sequences[0].tracks[0].clips).toHaveLength(0);
    const snapshot = proposalSnapshot(result);
    const sequence = snapshot.project.sequences[0];
    const media = programMediaAtPlayhead(snapshot.project, sequence, 0);
    expect(media?.source.source_id).toBe("source:b");
    expect(media?.sourceFrame).toBe(command.clip.source_in);
    expect(buildTimelineDeliveryPreflight(snapshot)).toMatchObject({
      blockers: [], pendingMulticamCount: 0, selectedMulticamCount: 1,
    });
  });

  it.each(["pending", "missing", "automatic_preferred"])("does not promote %s angle evidence into a Timeline choice", (status) => {
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].angle.status = status;
    // Even a populated source identity or script_supervisor field must not
    // replace Assembly's explicit decision status.
    const result = buildAssemblyTimelineProposal(review(), nextAssembly, ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(command.clip.multicam_group_id).toBe("g1");
    const snapshot = proposalSnapshot(result);
    expect(programMediaAtPlayhead(snapshot.project, snapshot.project.sequences[0], 0)).toBeNull();
    expect(buildTimelineDeliveryPreflight(snapshot).pendingMulticamCount).toBe(1);
  });

  it("keeps an undecided multicam pending without choosing the inventory's first angle", () => {
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].angle.status = "pending";
    nextAssembly.scenes[0].blocks[0].angle.clip_id = "";
    const result = buildAssemblyTimelineProposal(review(), nextAssembly, ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:a");
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(result.warnings.some((warning) => warning.includes("机位保持待选"))).toBe(true);
  });

  it("does not collapse an unresolved multicam into a decided single angle when another source is offline", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles[1].playback.available = false;
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].angle.status = "pending";
    nextAssembly.scenes[0].blocks[0].angle.clip_id = "";
    const result = buildAssemblyTimelineProposal(nextReview, nextAssembly, ntsc23976);
    expect(result.commands).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("不能自动作为单机位采用");
  });

  it.each(["manual_preferred", "single_angle"])("preserves a resolved %s source when only that source is playable", (status) => {
    const nextReview = review();
    nextReview.take_groups[0].angles[0].playback.available = false;
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].angle.status = status;
    const result = buildAssemblyTimelineProposal(nextReview, nextAssembly, ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.multicam_group_id).toBeNull();
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(buildTimelineDeliveryPreflight(proposalSnapshot(result)).blockers).toEqual([]);
  });

  it("keeps a manual preference pending if any registered angle lacks valid typed sync", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles[0].source_end = 5;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(result.baseProject.multicam_groups[0].angles).toEqual([]);
    const snapshot = proposalSnapshot(result);
    expect(programMediaAtPlayhead(snapshot.project, snapshot.project.sequences[0], 0)).toBeNull();
    expect(buildTimelineDeliveryPreflight(snapshot).blockers.map((issue) => issue.code)).toContain("multicam_typed_sync_missing");
  });

  it("does not confirm a preferred angle whose sync range cannot cover the Assembly range", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles[1].source_end = 23;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.selected_angle_source_id).toBeNull();
    // Do not silently shorten an authoritative Assembly range to fit the source.
    expect(command.clip.source_in).toBe(Math.round(22 * 24000 / 1001));
    expect(command.clip.duration).toBe(Math.round(4 * 24000 / 1001));
    expect(buildTimelineDeliveryPreflight(proposalSnapshot(result)).pendingMulticamCount).toBe(1);
  });

  it("requires every registered angle to cover the range needed by Premiere multicam delivery", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles[0].source_end = 8;
    nextReview.take_groups[0].angles[0].duration = 3;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), { numerator: 24, denominator: 1 });
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_id).toBe("source:b");
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(command.clip.source_in).toBe(528);
    expect(command.clip.duration).toBe(96);
    // A later explicit selection cannot bypass the delivery range guard.
    const snapshot = proposalSnapshot(result);
    snapshot.project.sequences[0].tracks[0].clips[0].selected_angle_source_id = "source:b";
    expect(buildTimelineDeliveryPreflight(snapshot).blockers).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "multicam_sync_range_exceeded", message: expect.stringContaining("source:a") }),
    ]));
  });

  it("quantizes both absolute endpoints consistently at fractional frame rates", () => {
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].usable_range = { status: "full_take", start: 0, end: 10, duration: 10, issues: [] };
    const result = buildAssemblyTimelineProposal(review(), nextAssembly, ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.source_in).toBe(480);
    expect(command.clip.duration).toBe(239);
    expect(command.clip.source_in + command.clip.duration).toBe(719);
    expect(command.clip.selected_angle_source_id).toBe("source:b");
    expect(buildTimelineDeliveryPreflight(proposalSnapshot(result)).blockers).toEqual([]);
  });

  it("skips a preferred angle with a different Take origin rather than inventing its source range", () => {
    const nextReview = review();
    nextReview.take_groups[0].end = 12;
    nextReview.take_groups[0].duration = 12;
    nextReview.take_groups[0].angles[1].timeline_start = 2;
    nextReview.take_groups[0].angles[1].timeline_end = 12;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);
    expect(result.commands).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("不能推断源范围");
    expect(result.baseProject.multicam_groups[0].angles).toEqual([]);
  });

  it("does not publish typed sync when a non-preferred angle has a different Take origin", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles[0].timeline_start = 2;
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);
    const command = result.commands[0];
    if (command.type !== "insert") throw new Error("expected insert");
    expect(command.clip.selected_angle_source_id).toBeNull();
    expect(result.baseProject.multicam_groups[0].angles).toEqual([]);
    expect(buildTimelineDeliveryPreflight(proposalSnapshot(result)).blockers.map((item) => item.code)).toContain("multicam_typed_sync_missing");
  });

  it("skips ranges that collapse to zero frames instead of extending the human range", () => {
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].usable_range.end = 2.001;
    const result = buildAssemblyTimelineProposal(review(), nextAssembly, ntsc23976);
    expect(result.commands).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("不能自动扩展范围");
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

  it("does not substitute another source for a missing preferred source", () => {
    const nextReview = review();
    nextReview.take_groups[0].angles.pop();
    const result = buildAssemblyTimelineProposal(nextReview, assembly(), ntsc23976);
    expect(result.commands).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("Assembly 指定的基础 angle b 当前不可播放");
  });

  it("does not fall back to the first angle when a manual preference has no source identity", () => {
    const nextAssembly = assembly();
    nextAssembly.scenes[0].blocks[0].angle.clip_id = "";
    const result = buildAssemblyTimelineProposal(review(), nextAssembly, ntsc23976);
    expect(result.commands).toHaveLength(0);
    expect(result.skipped[0].reason).toContain("不能自动改选");
  });

  it("fails closed when no valid timebase is supplied", () => {
    expect(() => buildAssemblyTimelineProposal(review(), assembly(), { numerator: 0, denominator: 1 })).toThrow(
      "需要明确、有效的有理数时间基",
    );
  });
});
