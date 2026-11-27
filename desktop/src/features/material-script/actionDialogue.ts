import type { ReviewEpisode, ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import { isPlaceableScriptBlock } from "../script/scriptSemantics";
import { matchesScriptSpeech, scriptSpeechClauses } from "./scriptSpeech";

const DIALOGUE_CONFIDENCES = new Set(["exact_dialogue", "possible_dialogue", "manual"]);
const DIALOGUE_METHODS = new Set(["dialogue", "speech"]);

export function actionCoverageLabel(confirmed: number, possibleTogether: number, related: number): string {
  if (confirmed) return `${confirmed} 组人工关联`;
  if (possibleTogether) return `${possibleTogether} 组可能同拍`;
  return `${related} 组待核画面`;
}

export function confirmedOnTake(take: ReviewTakeGroup, segmentId: string): boolean {
  const mapping = take.effective_mapping;
  return mapping.source === "human" && !mapping.inherited && mapping.script_segment_ids.includes(segmentId);
}

/** Only an actual dialogue placement or a dialogue candidate can lead to an adjacent action. */
export function indexActionDialogue(episodes: readonly ReviewEpisode[], takes: readonly ReviewTakeGroup[]) {
  const actionsByDialogue = new Map<string, ReviewScriptBlock[]>();
  const dialogueById = new Map<string, ReviewScriptBlock>();
  const speechByDialogue = new Map<string, string[]>();
  const actionIds = new Set<string>();
  for (const episode of episodes) {
    for (const scene of episode.scenes) {
      const blocks = scene.script_blocks;
      blocks.forEach((dialogue, index) => {
        if (dialogue.type === "action") actionIds.add(dialogue.segment_id);
        if (dialogue.type !== "dialogue" || !isPlaceableScriptBlock(dialogue)) return;
        const actions: ReviewScriptBlock[] = [];
        for (const step of [-1, 1]) {
          const side: ReviewScriptBlock[] = [];
          for (let i = index + step; i >= 0 && i < blocks.length; i += step) {
            const block = blocks[i];
            if (block.type === "parenthetical") continue;
            if (block.type !== "action") break;
            side.push(block);
          }
          actions.push(...(step < 0 ? side.reverse() : side));
        }
        if (actions.length) {
          dialogueById.set(dialogue.segment_id, dialogue);
          actionsByDialogue.set(dialogue.segment_id, actions);
          speechByDialogue.set(dialogue.segment_id, scriptSpeechClauses(dialogue));
        }
      });
    }
  }

  const dialogueByActionTake = new Map<string, Map<string, ReviewScriptBlock[]>>();
  const confirmedActionTakeIds = new Map<string, string[]>();
  for (const take of takes) {
    const ids = new Set(take.effective_mapping.script_segment_ids);
    for (const id of ids) {
      if (!actionIds.has(id) || !confirmedOnTake(take, id)) continue;
      const groups = confirmedActionTakeIds.get(id);
      if (groups) groups.push(take.group_id);
      else confirmedActionTakeIds.set(id, [take.group_id]);
    }
    if (take.editorial_state.excluded) continue;
    for (const candidate of take.candidates) {
      if (candidate.confidence === "context_only") continue;
      if (!DIALOGUE_CONFIDENCES.has(candidate.confidence) && !DIALOGUE_METHODS.has(candidate.method)) continue;
      if (candidate.script_segment_id) ids.add(candidate.script_segment_id);
      const window = candidate.script_segment_ids ?? [];
      if (window.length === 1) ids.add(window[0]);
      // A speech window also contains stage directions and lines the actor may have skipped.
      for (const id of window) {
        const clauses = speechByDialogue.get(id);
        if (!ids.has(id) && clauses && candidate.transcript_text && matchesScriptSpeech(candidate.transcript_text, clauses)) ids.add(id);
      }
    }
    for (const id of ids) {
      const dialogue = dialogueById.get(id);
      if (!dialogue) continue;
      for (const action of actionsByDialogue.get(id)!) {
        let takesForAction = dialogueByActionTake.get(action.segment_id);
        if (!takesForAction) {
          takesForAction = new Map();
          dialogueByActionTake.set(action.segment_id, takesForAction);
        }
        const lines = takesForAction.get(take.group_id);
        if (lines) lines.push(dialogue);
        else takesForAction.set(take.group_id, [dialogue]);
      }
    }
  }
  return { actionsByDialogue, dialogueByActionTake, confirmedActionTakeIds };
}
