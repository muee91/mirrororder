import { describe, expect, it } from "vitest";
import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import {
  preferredScriptSegmentId,
  relatedTakeIds,
  takeMatchesFilters,
  takeStatus,
  virtualRange,
} from "./model";

function take(overrides: Partial<ReviewTakeGroup> = {}): ReviewTakeGroup {
  return {
    group_id: "g1",
    parent_group_id: "",
    kind: "multicam",
    take_index: 1,
    split_reason: "",
    start: 0,
    end: 10,
    duration: 10,
    cameras: ["A"],
    angles: [],
    transcript: { text: "", source: "none" },
    people: { faces: [], speakers: [] },
    candidates: [],
    context: { episode_ids: [], script_segment_ids: [] },
    automatic_state: {},
    editorial_state: {},
    effective_mapping: {
      source: "none",
      mapping_status: "unresolved",
      script_segment_ids: [],
      episode_ids: [],
    },
    issues: [],
    ...overrides,
  };
}

describe("material-script model", () => {
  it("keeps editorial rejection separate from mapping state", () => {
    expect(
      takeStatus(
        take({
          editorial_state: { legacy_manual: { effective_state: "reject" } },
          effective_mapping: {
            source: "human",
            mapping_status: "episode_only",
            script_segment_ids: [],
            episode_ids: [3],
          },
        }),
      ),
    ).toBe("rejected");
  });

  it("classifies human and automatic mappings as placed, including episode-only", () => {
    expect(
      takeStatus(
        take({
          effective_mapping: {
            source: "human",
            mapping_status: "episode_only",
            script_segment_ids: [],
            episode_ids: [3],
          },
        }),
      ),
    ).toBe("placed");
    expect(
      takeStatus(
        take({
          effective_mapping: {
            source: "automatic",
            mapping_status: "confirmed",
            script_segment_ids: ["s1"],
            episode_ids: [3],
          },
        }),
      ),
    ).toBe("placed");
  });

  it("separates candidate work from unresolved items without candidates", () => {
    expect(
      takeStatus(
        take({
          candidates: [
            {
              candidate_id: "c1",
              group_id: "g1",
              script_segment_id: "s1",
              script_segment_ids: ["s1"],
              episode_ids: [1],
              confidence: "candidate",
              total_score: 0.6,
              dialogue_score: 0.6,
              sequence_score: 0.5,
              context_score: 0.5,
              margin: 0.1,
              method: "test",
              transcript_text: "",
              evidence: [],
              context_episodes: [],
            },
          ],
        }),
      ),
    ).toBe("candidate");
    expect(takeStatus(take())).toBe("pending");
  });

  it("filters by related episode without promoting context to authority", () => {
    const item = take({ context: { episode_ids: [4], script_segment_ids: [] } });
    expect(takeMatchesFilters(item, "pending", 4)).toBe(true);
    expect(item.effective_mapping.source).toBe("none");
  });

  it("prefers authoritative mapping before candidate and context links", () => {
    const item = take({
      effective_mapping: {
        source: "human",
        mapping_status: "confirmed",
        script_segment_ids: ["human"],
        episode_ids: [2],
      },
      context: { episode_ids: [2], script_segment_ids: ["context"] },
    });
    expect(preferredScriptSegmentId(item)).toBe("human");
  });

  it("ranks linked Takes by mapping, then candidate, then context", () => {
    const mapped = take({
      group_id: "mapped",
      effective_mapping: {
        source: "human",
        mapping_status: "confirmed",
        script_segment_ids: ["s1"],
        episode_ids: [1],
      },
    });
    const context = take({ group_id: "context", context: { episode_ids: [1], script_segment_ids: ["s1"] } });
    const candidate = take({
      group_id: "candidate",
      candidates: [
        {
          candidate_id: "c1",
          group_id: "candidate",
          script_segment_id: "s1",
          script_segment_ids: ["s1"],
          episode_ids: [1],
          confidence: "candidate",
          total_score: 0.6,
          dialogue_score: 0.6,
          sequence_score: 0.5,
          context_score: 0.5,
          margin: 0.1,
          method: "test",
          transcript_text: "",
          evidence: [],
          context_episodes: [],
        },
      ],
    });
    const model = { take_groups: [context, candidate, mapped] } as ReviewModelPayload;
    expect(relatedTakeIds(model, "s1")).toEqual(["mapped", "candidate", "context"]);
  });

  it("computes a bounded virtual window rather than rendering the full list", () => {
    expect(virtualRange(1000, 2640, 528, 264, 2)).toEqual({
      start: 8,
      end: 14,
      paddingTop: 2112,
      paddingBottom: 260304,
    });
  });
});
