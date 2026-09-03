import { describe, expect, it } from "vitest";
import { collaborationAttention, type CollaborationEditorialState } from "./reviewAttention";

function opinion(
  state: string,
  actor: string,
  updatedAt: string,
  segmentId = "seg-1",
) {
  return {
    target: { kind: "assignment", group_id: "take-1", segment_id: segmentId },
    state,
    actor,
    reviewer_id: actor.toLowerCase(),
    updated_at: updatedAt,
  };
}

function decision(state: string, updatedAt: string, segmentId = "seg-1") {
  return {
    target: { kind: "assignment", group_id: "take-1", segment_id: segmentId },
    state,
    actor: "Editor",
    updated_at: updatedAt,
  };
}

describe("collaborationAttention", () => {
  it("keeps a Take quiet when there is no team feedback", () => {
    const result = collaborationAttention(undefined);
    expect(result.hasAttention).toBe(false);
    expect(result.labels).toEqual([]);
    expect(result.opinionCount).toBe(0);
  });

  it("returns unresolved and conflicting team opinions to the editor queue", () => {
    const state: CollaborationEditorialState = {
      individual_opinions: {
        assignments: [
          opinion("best", "Director", "2026-09-03T10:00:00Z"),
          opinion("reject", "Producer", "2026-09-03T10:02:00Z"),
        ],
      },
      editorial_decision: { assignments: [] },
    };
    const result = collaborationAttention(state);
    expect(result.hasAttention).toBe(true);
    expect(result.pendingTargets).toBe(1);
    expect(result.conflictingTargets).toBe(1);
    expect(result.reviewerCount).toBe(2);
    expect(result.labels).toContain("团队意见待裁决（1项）");
    expect(result.labels).toContain("团队意见有分歧（1项）");
  });

  it("stops surfacing feedback after a newer final editorial decision", () => {
    const state: CollaborationEditorialState = {
      individual_opinions: {
        assignments: [opinion("keep", "Director", "2026-09-03T10:00:00Z")],
      },
      editorial_decision: {
        assignments: [decision("best", "2026-09-03T10:05:00Z")],
      },
    };
    const result = collaborationAttention(state);
    expect(result.hasAttention).toBe(false);
    expect(result.labels).toEqual([]);
  });

  it("reopens attention when a reviewer changes opinion after the final decision", () => {
    const state: CollaborationEditorialState = {
      individual_opinions: {
        assignments: [opinion("reject", "Director", "2026-09-03T10:08:00Z")],
      },
      editorial_decision: {
        assignments: [decision("keep", "2026-09-03T10:05:00Z")],
      },
    };
    const result = collaborationAttention(state);
    expect(result.hasAttention).toBe(true);
    expect(result.newerTargets).toBe(1);
    expect(result.priority).toBeGreaterThanOrEqual(950);
    expect(result.labels).toEqual(["最终决定后收到新意见（1项）"]);
  });

  it("tracks group and assignment feedback as separate editorial targets", () => {
    const state: CollaborationEditorialState = {
      individual_opinions: {
        group: [{
          target: { kind: "group", group_id: "take-1" },
          state: "keep",
          actor: "Director",
          reviewer_id: "director",
          updated_at: "2026-09-03T10:00:00Z",
        }],
        assignments: [opinion("best", "Producer", "2026-09-03T10:01:00Z", "seg-2")],
      },
      editorial_decision: {
        group: {
          target: { kind: "group", group_id: "take-1" },
          state: "keep",
          actor: "Editor",
          updated_at: "2026-09-03T10:02:00Z",
        },
        assignments: [],
      },
    };
    const result = collaborationAttention(state);
    expect(result.pendingTargets).toBe(1);
    expect(result.opinionCount).toBe(2);
    expect(result.reviewerCount).toBe(2);
  });
});
