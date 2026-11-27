import { describe, expect, it } from "vitest";
import type { ReviewAngle, ReviewTakeGroup } from "../api/host";
import { formatClock, hasTakeOpinionConflict, syncAngleTime, takeComments } from "./teamModel";

function makeAngle(clipId: string, timelineStart: number, timelineEnd: number, sourceStart = 0): ReviewAngle {
  return {
    clip_id: clipId,
    media_id: `m-${clipId}`,
    camera: clipId.toUpperCase(),
    name: `${clipId}.mov`,
    timeline_start: timelineStart,
    timeline_end: timelineEnd,
    duration: timelineEnd - timelineStart,
    source_start: sourceStart,
    source_end: sourceStart + (timelineEnd - timelineStart),
    shot_type: "medium",
    coverage_role: "dialogue",
    playback: {
      available: true,
      url: `/api/v1/projects/p1/media/${clipId}`,
      source_start: sourceStart,
      source_end: sourceStart + (timelineEnd - timelineStart),
    },
  };
}

describe("teamModel", () => {
  it("formats clock in mm:ss", () => {
    expect(formatClock(0)).toBe("00:00");
    expect(formatClock(28.7)).toBe("00:28");
    expect(formatClock(125)).toBe("02:05");
  });

  it("syncs source time across cameras within overlapping timeline range", () => {
    const camA = makeAngle("a", 10, 30, 0);
    const camB = makeAngle("b", 12, 28, 5);

    expect(syncAngleTime(camA, camB, 10)).toBe(13);
    expect(syncAngleTime(camA, camB, 0)).toBeNull();
  });

  it("detects opinion conflicts and extracts comments", () => {
    const take = {
      group_id: "G1",
      editorial_state: {
        individual_opinions: {
          group: [
            { state: "best", actor: "导演", reviewer_id: "r1", updated_at: "2026-11-27T10:00:00Z" },
            { state: "reject", actor: "制片", reviewer_id: "r2", updated_at: "2026-11-27T10:01:00Z" },
          ],
          assignments: [],
        },
        comments: [
          {
            comment_id: "cmt_1",
            group_id: "G1",
            text: "B机虚焦",
            actor: "导演",
            created_at: "2026-11-27T10:02:00Z",
          },
        ],
      },
    } as unknown as ReviewTakeGroup;

    expect(hasTakeOpinionConflict(take)).toBe(true);
    expect(takeComments(take)).toHaveLength(1);
    expect(takeComments(take)[0].text).toBe("B机虚焦");
  });
});
