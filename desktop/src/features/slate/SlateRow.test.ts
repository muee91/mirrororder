import { describe, expect, it } from "vitest";
import { SLATE_CAMERA_COLUMNS, SLATE_COLUMN_KEYS, looksLikeQuickSlateCommand } from "./SlateRow";
import { formatCompactMediaName } from "../media/MirrorOrderMediaCard";

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
      "note",
    ]);
  });

  it("only treats explicit structured slate cues as quick commands", () => {
    expect(looksLikeQuickSlateCommand("EP3 12场 B近 可用")).toBe(true);
    expect(looksLikeQuickSlateCommand("12-3-2")).toBe(true);
    expect(looksLikeQuickSlateCommand("同上")).toBe(true);
    expect(looksLikeQuickSlateCommand("结尾笑场")).toBe(false);
    expect(looksLikeQuickSlateCommand("声音轻微爆音")).toBe(false);
    expect(looksLikeQuickSlateCommand("演员走位微调")).toBe(false);
  });

  it("keeps compact media names complete while stripping extensions", () => {
    expect(formatCompactMediaName("A001C123")).toBe("A001C123");
    expect(formatCompactMediaName("A001.MOV")).toBe("A001");
    expect(formatCompactMediaName("A001C001_261110BR")).toBe("A001C001_261110BR");
    expect(formatCompactMediaName("DJI_20261110142312_0042_D.MP4")).toBe("DJI_20261110142312_0042_D");
    expect(formatCompactMediaName("  ")).toBe("");
  });

  it("keeps camera columns stable even when media is absent", () => {
    expect(SLATE_CAMERA_COLUMNS).toEqual(["A", "B", "C", "AUX"]);
  });
});
