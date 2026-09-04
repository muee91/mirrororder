import { describe, expect, it } from "vitest";
import { SLATE_CAMERA_COLUMNS, SLATE_COLUMN_KEYS } from "./SlateRow";

describe("SlateRow anatomy contract", () => {
  it("keeps the ledger columns in the fixed production order", () => {
    expect(SLATE_COLUMN_KEYS).toEqual([
      "index",
      "episode",
      "scene",
      "shot",
      "take",
      "camera-A",
      "camera-B",
      "camera-C",
      "camera-AUX",
      "status",
    ]);
  });

  it("keeps camera columns stable even when media is absent", () => {
    expect(SLATE_CAMERA_COLUMNS).toEqual(["A", "B", "C", "AUX"]);
  });
});
