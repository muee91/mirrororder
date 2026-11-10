import { execFileSync } from "node:child_process";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReviewModelPayload } from "../../api/host";
import type { AssemblyTimeline } from "../../api/production";
import type { FrameRate, TimelineProject } from "../../api/timeline";
import { buildTimelineDeliveryPreflight } from "../delivery/deliveryPreflight";
import { buildAssemblyTimelineProposal } from "./timelineSeed";
import { buildReplaceTakeCommand, buildTimelineSourceOptions } from "./timelineSourceEditing";

const root = fileURLToPath(new URL("../../../../", import.meta.url));

function buildProposal(rate: FrameRate, shortOtherAngle = false, fullTake = false, unusedUnalignedTake = false) {
  const review = {
    project: { project_id: "p1" },
    take_groups: [{ group_id: "g1", start: 0, angles: [
      { clip_id: "a", media_id: "ma", camera: "A", name: "A.mov", timeline_start: 0, source_start: 5, source_end: shortOtherAngle ? 8 : 15, duration: shortOtherAngle ? 3 : 10, playback: { available: true } },
      { clip_id: "b", media_id: "mb", camera: "B", name: "B.mov", timeline_start: 0, source_start: 20, source_end: 30, duration: 10, playback: { available: true } },
    ] }],
  } as unknown as ReviewModelPayload;
  if (unusedUnalignedTake) {
    const unused = structuredClone(review.take_groups[0]);
    unused.group_id = "unused";
    unused.angles[0].clip_id = "c";
    unused.angles[1].clip_id = "d";
    unused.angles[1].timeline_start = 2;
    review.take_groups.push(unused);
  }
  const assembly = {
    contract: "assembly_timeline.v2", revision: "a1", scenes: [{ blocks: [{
      block_id: "b1", kind: "source", group_id: "g1", script_segment_ids: ["s1"], selection_status: "explicit_best",
      decision_source: "editorial_decision", angle: { status: "manual_preferred", clip_id: "b" },
      usable_range: { status: "manual", start: fullTake ? 0 : 2, end: fullTake ? 10 : 6 }, assembly_status: "ready",
    }] }],
  } as unknown as AssemblyTimeline;
  const proposal = buildAssemblyTimelineProposal(review, assembly, rate);
  const project = structuredClone(proposal.baseProject);
  for (const command of proposal.commands) {
    if (command.type !== "insert") throw new Error("expected insert");
    project.sequences[0].tracks[0].clips.push(command.clip);
  }
  return { project, review, undo_depth: 0, redo_depth: 0, validation: [], authority: { generation: "test", revision: 1 } };
}

function exportProposal(project: TimelineProject) {
  return JSON.parse(execFileSync(process.env.MIRRORORDER_PYTHON || (process.platform === "win32" ? "python" : "python3"), [join(root, "tests/fixtures/assembly-delivery/export_proposal.py")], {
    input: JSON.stringify(project), encoding: "utf8", cwd: root,
    env: { ...process.env, PYTHONPATH: [join(root, "src"), process.env.PYTHONPATH].filter(Boolean).join(delimiter) },
  }));
}

describe("Assembly proposal to real NLE adapters", () => {
  it.each([
    { numerator: 24, denominator: 1 },
    { numerator: 24000, denominator: 1001 },
  ])("exports the confirmed preferred angle at $numerator/$denominator without another choice", (rate) => {
    const snapshot = buildProposal(rate, false, true);
    expect(buildTimelineDeliveryPreflight(snapshot).blockers).toEqual([]);
    const clip = snapshot.project.sequences[0].tracks[0].clips[0];
    const output = exportProposal(snapshot.project);
    expect(output.fcpxml).toMatchObject({ ok: true, video_clip_count: 1, selected_angle: "B" });
    expect(output.premiere).toMatchObject({ ok: true, video_clip_count: 1, edit: {
      name: "B.mov", in: String(clip.source_in), out: String(clip.source_in + clip.duration),
    } });
  });

  it("blocks a short alternate angle before Premiere rejects it, even after an explicit switch", () => {
    const snapshot = buildProposal({ numerator: 24, denominator: 1 }, true);
    const clip = snapshot.project.sequences[0].tracks[0].clips[0];
    expect(clip.selected_angle_source_id).toBeNull();
    clip.selected_angle_source_id = "source:b";
    expect(buildTimelineDeliveryPreflight(snapshot).blockers.map((item) => item.code)).toContain("multicam_sync_range_exceeded");
    const output = exportProposal(snapshot.project);
    expect(output.premiere).toMatchObject({ ok: false, error: expect.stringContaining("exceeds typed sync range") });
  });

  it("exports only referenced groups without losing unused multicam source options", () => {
    const snapshot = buildProposal({ numerator: 24, denominator: 1 }, false, false, true);
    const sequence = snapshot.project.sequences[0];
    expect(snapshot.project.sources).toHaveLength(4);
    expect(snapshot.project.multicam_groups.find((group) => group.group_id === "unused")?.angles).toEqual([]);
    const options = buildTimelineSourceOptions(snapshot.review, snapshot.project, sequence);
    const unused = options.find((option) => option.source.source_id === "source:c")!;
    expect(unused.multicamGroupId).toBe("unused");
    expect(buildReplaceTakeCommand(sequence, sequence.tracks[0].clips[0], unused, unused.availableIn)).toMatchObject({ group_id: "unused", source_id: "source:c" });
    expect(buildTimelineDeliveryPreflight(snapshot).blockers).toEqual([]);
    const output = exportProposal(snapshot.project);
    expect(output.fcpxml.ok).toBe(true);
    expect(output.premiere.ok).toBe(true);
    expect(output.resources).toEqual({ groups: ["g1"], sources: ["source:a", "source:b"] });
    expect(snapshot.project.multicam_groups).toHaveLength(2);

    // A later manual use retains the group identity and must not degrade into
    // a single-source clip to bypass its missing synchronization evidence.
    sequence.tracks[0].clips.push({ ...sequence.tracks[0].clips[0], clip_id: "manual", source_id: "source:c", source_in: unused.availableIn, timeline_start: 96, multicam_group_id: "unused", selected_angle_source_id: "source:c" });
    expect(buildTimelineDeliveryPreflight(snapshot).blockers.map((item) => item.code)).toContain("multicam_typed_sync_missing");
    const blocked = exportProposal(snapshot.project);
    expect(blocked.fcpxml).toMatchObject({ ok: false, error: expect.stringContaining("typed angles") });
    expect(blocked.premiere).toMatchObject({ ok: false, error: expect.stringContaining("typed angles") });
  });
});
