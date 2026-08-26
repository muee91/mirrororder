import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReviewTakeGroup } from "../../api/host";
import type { MediaInventoryItem } from "../../api/mediaRoles";
import {
  buildSlatePools,
  createSlateTakeDragPayload,
  decodeSlateTakeDragPayload,
  hasHumanPlacement,
  isReviewExcluded,
} from "./slatePools";

function take(overrides: Partial<ReviewTakeGroup> = {}): ReviewTakeGroup {
  return {
    group_id: "g1",
    parent_group_id: "",
    kind: "single",
    take_index: 1,
    split_reason: "",
    start: 0,
    end: 10,
    duration: 10,
    cameras: ["A"],
    angles: [{
      clip_id: "clip-1",
      media_id: "media-1",
      camera: "A",
      name: "A001.MOV",
      timeline_start: 0,
      timeline_end: 10,
      duration: 10,
      source_start: 0,
      source_end: 10,
      playback: { url: "/media/clip-1", source_start: 0, source_end: 10 },
    }],
    transcript: { text: "", source: "none" },
    people: { faces: [], speakers: [] },
    candidates: [],
    context: { episode_ids: [], script_segment_ids: [] },
    automatic_state: {},
    editorial_state: { legacy_manual: {} },
    effective_mapping: { source: "none", mapping_status: "none", script_segment_ids: [], episode_ids: [] },
    issues: [],
    ...overrides,
  };
}

function media(mediaId: string): MediaInventoryItem {
  return { media_id: mediaId, display_name: `${mediaId}.mov`, folder_label: "rushes", inferred_camera: "A", indexed: true, label: {} };
}

describe("slate intake pools", () => {
  it("classifies Review placement and exclusion without using Slate NG or Editorial Decision", () => {
    const pending = take({ group_id: "pending" });
    const placed = take({
      group_id: "placed",
      editorial_state: { legacy_manual: { placement: { episode_ids: [3], script_segment_ids: ["s1"] } } },
      effective_mapping: { source: "human", mapping_status: "exact", script_segment_ids: ["s1"], episode_ids: [3] },
    });
    const excluded = take({ group_id: "excluded", editorial_state: { legacy_manual: { effective_state: "reject" } } });
    const slateNg = take({ group_id: "slate-ng" });
    const editorialReject = take({ group_id: "editorial-reject", editorial_state: { legacy_manual: {}, editorial_decision: { state: "reject" } } });
    const pools = buildSlatePools([pending, placed, excluded, slateNg, editorialReject], [media("media-1"), media("orphan-1")]);

    expect(pools.pending.map((item) => item.group_id)).toEqual(["pending", "slate-ng", "editorial-reject"]);
    expect(pools.placed.map((item) => item.group_id)).toEqual(["placed"]);
    expect(pools.excluded.map((item) => item.group_id)).toEqual(["excluded"]);
    expect(pools.orphan.map((item) => item.media_id)).toEqual(["orphan-1"]);
    expect(isReviewExcluded(slateNg)).toBe(false);
    expect(hasHumanPlacement(placed)).toBe(true);
  });

  it("accepts only the fixed typed drag payload schema", () => {
    const payload = createSlateTakeDragPayload(take({ group_id: "drag-me" }));
    expect(payload).toEqual({ version: 1, kind: "take", groupId: "drag-me", sourceKind: "take", sourceClipId: "clip-1" });
    expect(decodeSlateTakeDragPayload(JSON.stringify(payload))).toEqual(payload);
    expect(decodeSlateTakeDragPayload(JSON.stringify({ groupId: "drag-me" }))).toBeNull();
    expect(decodeSlateTakeDragPayload(JSON.stringify({ version: 1, kind: "take", sourceKind: "clip", groupId: "drag-me" }))).toBeNull();
    expect(decodeSlateTakeDragPayload("not arbitrary JSON")).toBeNull();
  });

  it("keeps the four pools and Review drag actions on the main Slate workbench", () => {
    const source = readFileSync(fileURLToPath(new URL("./SlateWorkbench.tsx", import.meta.url)), "utf8");
    for (const label of ["待归集", "已归集", "已排除", "孤立素材"]) expect(source).toContain(label);
    expect(source).toContain("SLATE_TAKE_MIME");
    expect(source).toContain('sourceSurface: "slate-table"');
    expect(source).toContain("host.setGroupPlacement");
    expect(source).toContain("host.clearGroupPlacement");
    expect(source).toContain("host.setGroupExclusion");
    expect(source).not.toContain("production.writeSlateEntry(projectId, {\n        groupId: payload.groupId");
  });
});
