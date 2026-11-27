import { describe, expect, it } from "vitest";
import fixture from "../../../../tests/fixtures/desktop-review/review-model.json";
import type { ReviewTakeGroup } from "../../api/host";
import type { SlateBoard, SlateEntry, SlateRecord } from "../../api/production";
import { finalDecision, indexReviewSlates, matchesSlateStatus } from "./reviewFootageFacts";

const source = fixture.take_groups[0];
const take: ReviewTakeGroup = { ...source, angles: ["A", "B"].map(camera => ({
  ...source.angles[0], camera, clip_id: camera, media_id: "media-" + camera,
})) };
const base: SlateRecord = { record_id: "whole", source_group_id: take.group_id, episode: 1, scene: "1", shot: "1",
  take_number: 1, script_scene_id: "", status: "usable", preferred_clip_id: "A", note: "保条", attachments: [], actor: "场记", updated_at: "" };
const board: SlateBoard = { version: 2, revision: 3, updated_at: "", contract: "script_supervisor.v2", records: {}, entries: {}, semantics: {} };

describe("footage status in review", () => {
  it("keeps the whole Take, an individual camera and the editor's decision independent", () => {
    const bOnly: SlateRecord = { ...base, record_id: "only-b", source_group_id: "", status: "ng", preferred_clip_id: "", note: "对焦漂移",
      attachments: [{ clip_id: "B", media_id: "media-B", camera: "B", note: "结尾虚焦", shot_type: "unknown", source_role: "", display_name: "B.mov" }] };
    const { facts } = indexReviewSlates([take], { ...board, records: { whole: base, onlyB: bOnly } });
    const tags = facts.get(take.group_id)!;
    expect(tags.take?.status).toBe("usable");
    expect(tags.angles.get("A")).toMatchObject({ preferred: true, note: "" });
    expect(tags.angles.get("B")).toMatchObject({ status: "ng", preferred: false, note: "结尾虚焦 · 对焦漂移" });
    expect(matchesSlateStatus(tags, "ng")).toBe(true);
    expect(finalDecision(take).state).toBe("unreviewed");
    expect(finalDecision({ ...take, editorial_state: { editorial_decision: { group: { state: "keep", actor: "剪辑师" } } } })).toEqual({ state: "keep", actor: "剪辑师" });
    expect(finalDecision({ ...take, editorial_state: { excluded: true, individual_opinion: { state: "reject" } } }).state).toBe("unreviewed");
    const otherSource = { ...take, angles: [{ ...take.angles[1], media_id: "another-file" }] };
    expect(indexReviewSlates([otherSource], { ...board, records: { onlyB: bOnly } }).facts.size).toBe(0);
  });

  it("reads older group entries and avoids reviving removed facts from an older snapshot", () => {
    const entry: SlateEntry = { ...base, group_id: take.group_id, status: "partial", usable_range: { start: 2, end: 8 },
      angles: { B: { shot_type: "unknown", note: "后半段穿帮" } } };
    const old = { ...take, script_supervisor: entry };
    expect(indexReviewSlates([old], null).facts.get(take.group_id)?.take?.usable_range).toEqual({ start: 2, end: 8 });
    expect(indexReviewSlates([take], { ...board, entries: { [take.group_id]: entry } }).facts.get(take.group_id)?.angles.get("B")?.note).toBe("后半段穿帮");
    expect(indexReviewSlates([old], board).facts.size).toBe(0);
  });
});
