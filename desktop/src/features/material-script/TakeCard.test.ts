import { describe, expect, it } from "vitest";
import type { ReviewAngle } from "../../api/host";
import { takeCameraSlots } from "./TakeCard";

function angle(clipId: string, camera: string): ReviewAngle {
  return { clip_id: clipId, camera } as ReviewAngle;
}

describe("TakeCard camera slot contract", () => {
  it("keeps A/B/C/AUX positions stable when a camera is missing", () => {
    const slots = takeCameraSlots([
      angle("a-1", "A"),
      angle("c-1", "C"),
    ]);

    expect(slots.slice(0, 4).map((slot) => slot.label)).toEqual(["A机", "B机", "C机", "AUX"]);
    expect(slots[0].angles.map((item) => item.clip_id)).toEqual(["a-1"]);
    expect(slots[1].angles).toEqual([]);
    expect(slots[2].angles.map((item) => item.clip_id)).toEqual(["c-1"]);
    expect(slots[3].angles).toEqual([]);
  });

  it("keeps duplicates in their semantic slot and appends custom cameras after AUX", () => {
    const slots = takeCameraSlots([
      angle("b-1", "B"),
      angle("b-2", "B机"),
      angle("custom-1", "Gimbal"),
    ]);

    expect(slots[1].angles.map((item) => item.clip_id)).toEqual(["b-1", "b-2"]);
    expect(slots[4].label).toBe("Gimbal");
    expect(slots[4].angles.map((item) => item.clip_id)).toEqual(["custom-1"]);
  });
});
