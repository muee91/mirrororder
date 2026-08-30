import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { MediaInventoryItem } from "../../api/mediaRoles";
import {
  buildSlatePools,
  buildSlateSceneTargets,
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

  it("keeps every non-heading segment in a scene in stable script order", () => {
    const review = {
      episodes: [{
        episode: 2,
        scenes: [{
          scene_id: "2-1",
          heading: "室内",
          script_blocks: [
            { type: "scene_heading", segment_id: "heading" },
            { type: "dialogue", segment_id: "seg-1" },
            { type: "action", segment_id: "seg-2" },
            { type: "dialogue", segment_id: "seg-3" },
            { type: "dialogue", segment_id: "seg-2" },
          ],
        }],
      }],
    } as unknown as ReviewModelPayload;

    expect(buildSlateSceneTargets(review)[0]?.segmentIds).toEqual(["seg-1", "seg-2", "seg-3"]);
  });

  it("represents an empty scene without inventing an episode-only target", () => {
    const review = {
      episodes: [{
        episode: 2,
        scenes: [{ scene_id: "2-2", heading: "空场", script_blocks: [{ type: "scene_heading", segment_id: "heading" }] }],
      }],
    } as unknown as ReviewModelPayload;

    expect(buildSlateSceneTargets(review)[0]?.segmentIds).toEqual([]);
  });

  it("keeps the four pools and Review drag actions on the main Slate workbench", () => {
    const source = readFileSync(fileURLToPath(new URL("./GoldenSlateWorkbench.tsx", import.meta.url)), "utf8");
    const placement = readFileSync(fileURLToPath(new URL("./SlatePlacementPools.tsx", import.meta.url)), "utf8");
    for (const label of ["待归集", "已归集", "已排除", "孤立素材"]) expect(placement).toContain(label);
    expect(source).toContain("<SlateWorkbench");
    expect(source).toContain("Review 归集辅助");
    expect(placement).toContain("SLATE_TAKE_MIME");
    expect(placement).toContain('sourceSurface: "golden-slate-placement-pools"');
    expect(placement).toContain("host.setGroupPlacement");
    expect(placement).toContain("host.clearGroupPlacement");
    expect(placement).toContain("host.setGroupExclusion");
    expect(placement).toContain("scriptSegmentIds: target.segmentIds");
    expect(placement).toContain("!target.segmentIds.length");
    expect(placement).toContain("无可归集剧本段");
    expect(placement.indexOf("if (!drag || !review || !target.segmentIds.length)")).toBeLessThan(placement.indexOf("host.setGroupPlacement"));
    expect(placement).not.toContain("scriptSegmentIds: target.segmentId ? [target.segmentId]");
    const materialSource = readFileSync(fileURLToPath(new URL("../material-script/MaterialScriptWorkbench.tsx", import.meta.url)), "utf8");
    expect(materialSource).toContain("[block.segment_id]");
    expect(materialSource).toContain('"desktop-v2-script-segment"');
    expect(source).not.toContain("production.writeSlateEntry(projectId, {\n        groupId: payload.groupId");
  });
});
