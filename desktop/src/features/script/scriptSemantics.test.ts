import { describe, expect, it } from "vitest";
import { isPlaceableScriptBlock } from "./scriptSemantics";

function block(type: string, speaker = ""): { type: string; speaker: string } {
  return { type, speaker };
}

describe("script placement semantics", () => {
  it("keeps shot-bearing content placeable", () => {
    expect(isPlaceableScriptBlock(block("action"))).toBe(true);
    expect(isPlaceableScriptBlock(block("dialogue", "旁白/解说"))).toBe(true);
    expect(isPlaceableScriptBlock(block("other"))).toBe(true);
  });

  it("keeps structural rows visible without making them material targets", () => {
    expect(isPlaceableScriptBlock(block("scene_heading"))).toBe(false);
    expect(isPlaceableScriptBlock(block("transition"))).toBe(false);
    expect(isPlaceableScriptBlock(block("parenthetical"))).toBe(false);
    expect(isPlaceableScriptBlock(block("character"))).toBe(false);
    expect(isPlaceableScriptBlock(block("dialogue", "人物"))).toBe(false);
  });

  it("does not suppress a real dialogue speaker named 角色", () => {
    expect(isPlaceableScriptBlock(block("dialogue", "角色"))).toBe(true);
  });
});
