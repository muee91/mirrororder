import type { ReviewScriptBlock } from "../../api/host";

const NON_PLACEABLE_SCRIPT_BLOCK_TYPES = new Set([
  "scene_heading",
  "transition",
  "parenthetical",
  "character",
]);
const NON_PLACEABLE_SCRIPT_SPEAKERS = new Set([
  "人物",
  "人物表",
  "人物列表",
  "角色表",
  "角色列表",
]);

/** Structural script rows stay visible for context but cannot receive Takes. */
export function isPlaceableScriptBlock(block: Pick<ReviewScriptBlock, "type" | "speaker">): boolean {
  const type = String(block.type ?? "").trim().toLocaleLowerCase("zh-CN");
  const speaker = String(block.speaker ?? "").trim().replace(/\s+/g, "");
  return !NON_PLACEABLE_SCRIPT_BLOCK_TYPES.has(type) && !NON_PLACEABLE_SCRIPT_SPEAKERS.has(speaker);
}
