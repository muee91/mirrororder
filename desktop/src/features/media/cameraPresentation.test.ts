import { describe, expect, it } from "vitest";
import { cameraFilterKey, cameraPresentation, effectiveCamera } from "./cameraPresentation";

describe("cameraPresentation", () => {
  it("gives A/B/C stable first-class labels and tones", () => {
    expect(cameraPresentation("A机")).toMatchObject({ key: "A", label: "A机", tone: "a", sortOrder: 10 });
    expect(cameraPresentation("B")).toMatchObject({ key: "B", label: "B机", tone: "b", sortOrder: 20 });
    expect(cameraPresentation("C")).toMatchObject({ key: "C", label: "C机", tone: "c", sortOrder: 30 });
  });

  it("does not weakly classify ordinary words containing A/B/C as a camera", () => {
    expect(cameraPresentation("AERIAL")).toMatchObject({ key: "AERIAL", label: "AERIAL", tone: "custom" });
    expect(cameraPresentation("BROLL")).toMatchObject({ key: "BROLL", label: "BROLL", tone: "custom" });
  });

  it("keeps numbered strong camera labels in their camera family", () => {
    expect(cameraPresentation("A001")).toMatchObject({ key: "A001", label: "A001", tone: "a" });
    expect(cameraPresentation("B2")).toMatchObject({ key: "B2", label: "B2", tone: "b" });
  });

  it("prefers the shared human override and falls back to detected camera", () => {
    expect(effectiveCamera("C", "A").label).toBe("C机");
    expect(effectiveCamera("", "B").label).toBe("B机");
    expect(cameraFilterKey("", "?")).toBe("__unknown__");
  });
});
