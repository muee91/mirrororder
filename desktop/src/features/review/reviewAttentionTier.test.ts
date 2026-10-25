import { describe, expect, it } from "vitest";
import type { ReviewTakeGroup } from "../../api/host";
import { reviewTakeAttention } from "./reviewAttention";

function take(overrides: {
  issues?: Array<{ label: string; severity: string }>;
  mappingSource?: string;
  auditState?: Record<string, unknown>;
}): ReviewTakeGroup {
  return {
    group_id: "g1",
    parent_group_id: "",
    kind: "single",
    take_index: 1,
    split_reason: "",
    start: 0,
    end: 8,
    duration: 8,
    cameras: ["A"],
    angles: [],
    transcript: { text: "", source: "none" },
    people: { faces: [], speakers: [] },
    candidates: [],
    context: { episode_ids: [], script_segment_ids: [] },
    automatic_state: {},
    editorial_state: {},
    effective_mapping: { source: overrides.mappingSource ?? "human", mapping_status: "confirmed", script_segment_ids: [], episode_ids: [] },
    issues: overrides.issues ?? [],
    ...(overrides.auditState ? { audit_state: overrides.auditState } : {}),
  } as unknown as ReviewTakeGroup;
}

describe("reviewTakeAttention tiers", () => {
  it("marks error-severity issues as blocking", () => {
    const projection = reviewTakeAttention(take({ issues: [{ label: "素材缺失", severity: "error" }] }));
    expect(projection.hasAttention).toBe(true);
    expect(projection.tier).toBe("blocking");
  });

  it("marks stale analysis evidence as stale when nothing blocks", () => {
    const projection = reviewTakeAttention(take({
      issues: [{ label: "归集证据不足", severity: "warning" }],
      auditState: { analysis_stale: true },
    }));
    expect(projection.tier).toBe("stale");
    expect(projection.labels).toContain("分析证据已过期");
  });

  it("keeps mapping-only takes as watch tier but still counted as attention", () => {
    const projection = reviewTakeAttention(take({ mappingSource: "none" }));
    expect(projection.tier).toBe("watch");
    expect(projection.hasAttention).toBe(true);
    expect(projection.labels).toContain("尚未形成有效归集");
  });

  it("reports no attention for a clean, current, mapped take", () => {
    const projection = reviewTakeAttention(take({}));
    expect(projection.hasAttention).toBe(false);
    expect(projection.labels).toEqual([]);
  });
});
