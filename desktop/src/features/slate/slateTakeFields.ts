import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";
import type { SlatePaperSuggestion, SlatePaperSuggestions } from "../../api/production";

export type SceneLink = { episode: number; sceneId: string };

export function automaticMappingConfirmed(take: ReviewTakeGroup): boolean {
  return take.automatic_state.status === "auto_confirmed" || take.automatic_state.status === "ai_confirmed";
}

function sceneForSegments(review: ReviewModelPayload, ids: readonly string[]): SceneLink | null {
  if (!ids.length) return null;
  const wanted = new Set(ids);
  let mapped: SceneLink | null = null;
  for (const episode of review.episodes) {
    for (const scene of episode.scenes) {
      if (scene.script_blocks.some((block) => wanted.has(block.segment_id))) {
        if (mapped) return null;
        mapped = { episode: episode.episode, sceneId: scene.scene_id };
      }
    }
  }
  return mapped;
}

export function mappedScene(review: ReviewModelPayload, take: ReviewTakeGroup): SceneLink | null {
  const effectiveIds = take.effective_mapping.script_segment_ids;
  const automaticIds = automaticMappingConfirmed(take) ? take.automatic_state.script_segment_ids ?? [] : [];
  return sceneForSegments(review, effectiveIds.length ? effectiveIds : automaticIds);
}

function derivedSource(take: ReviewTakeGroup): string {
  if (take.automatic_state.status === "ai_confirmed") return "AI";
  if (take.automatic_state.status === "auto_confirmed") return "自动";
  if (take.effective_mapping.source === "human") return "映射";
  return "Take";
}

export function prettySceneId(value: string): string {
  // SC_1_1 这类内部段 ID 对用户没有意义；转成场号习惯的 "1-1"。
  const match = /^SC_?(\d+)_(\d+)$/.exec(value.trim());
  return match ? `${match[1]}-${match[2]}` : value;
}

function scriptSceneForNumber(review: ReviewModelPayload, scene: string): SceneLink | null {
  const target = scene.trim();
  if (!target) return null;
  const matches = review.episodes.flatMap((episode) => episode.scenes
    .filter((item) => prettySceneId(item.scene_id).trim() === target)
    .map((item) => ({ episode: episode.episode, sceneId: item.scene_id })));
  return matches.length === 1 ? matches[0] : null;
}

function sceneCrossCheck(take: ReviewTakeGroup) {
  const evidence = take.automatic_state.evidence?.scene_cross_check;
  if (!evidence || typeof evidence !== "object" || !("verdict" in evidence)
      || !("scene_id" in evidence) || !("episode" in evidence)) return null;
  return evidence;
}

function crossCheckedScene(review: ReviewModelPayload, take: ReviewTakeGroup): SceneLink | null {
  const evidence = sceneCrossCheck(take);
  if (evidence?.verdict !== "agrees") return null;
  const episode = review.episodes.find((item) => item.episode === evidence.episode);
  const scene = episode?.scenes.find((item) => item.scene_id === evidence.scene_id);
  return episode && scene ? { episode: episode.episode, sceneId: scene.scene_id } : null;
}

function dialogueScene(review: ReviewModelPayload, take: ReviewTakeGroup): SceneLink | null {
  const spoken = take.candidates.filter((candidate) => candidate.confidence !== "context_only"
    && candidate.dialogue_score >= 0.65 && (candidate.transcript_text?.trim().length ?? 0) >= 12);
  const top = spoken[0];
  if (!top || top.dialogue_score < 0.78 || top.total_score < 0.65) return null;
  const scene = sceneForSegments(review, top.script_segment_ids);
  if (!scene) return null;
  for (const candidate of spoken.slice(1)) {
    if (top.dialogue_score - candidate.dialogue_score >= 0.12) continue;
    const other = sceneForSegments(review, candidate.script_segment_ids);
    if (!other || other.episode !== scene.episode || other.sceneId !== scene.sceneId) return null;
  }
  return scene;
}

function paperSuggestionValue(suggestion: SlatePaperSuggestion | undefined, field: "scene" | "shot" | "take"): string {
  const reading = suggestion?.fields[field];
  return reading?.state === "suggested" ? reading.value.trim() : "";
}

export function adjacentPaperSceneContext(review: ReviewModelPayload, paperSuggestions?: SlatePaperSuggestions | null): Map<string, string> {
  const explicit = review.take_groups.flatMap((take, index) => {
    const scene = paperSuggestionValue(paperSuggestions?.groups[take.group_id], "scene");
    return scene ? [{ index, groupId: take.group_id, scene }] : [];
  });
  const context = new Map<string, string>();
  for (let index = 1; index < explicit.length; index += 1) {
    const previous = explicit[index - 1];
    const next = explicit[index];
    if (next.index - previous.index !== 2 || next.scene !== previous.scene) continue;
    const missing = review.take_groups[previous.index + 1];
    if (missing) context.set(missing.group_id, previous.scene);
  }
  return context;
}

export function parseTakeNumber(value: string): number | null {
  const match = /(\d+)/.exec(value.trim());
  if (!match) return null;
  const parsed = Number(match[1]);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

export function deriveSlateTakeFields(
  review: ReviewModelPayload,
  take: ReviewTakeGroup,
  paperSuggestions?: SlatePaperSuggestions | null,
  paperSceneContext?: ReadonlyMap<string, string>,
) {
  const mapped = mappedScene(review, take);
  const paper = paperSuggestions?.groups[take.group_id];
  const directPaperScene = paperSuggestionValue(paper, "scene");
  const isHumanMapping = take.effective_mapping.source === "human";
  const hasConflict = sceneCrossCheck(take)?.verdict === "conflicts";
  const contextualScene = hasConflict ? "" : paperSceneContext?.get(take.group_id) || "";
  const checked = crossCheckedScene(review, take);
  const dialogue = isHumanMapping || hasConflict ? null : dialogueScene(review, take);
  const suggested = isHumanMapping ? mapped : hasConflict ? null : checked ?? mapped ?? dialogue;
  const scene = (isHumanMapping && mapped ? prettySceneId(mapped.sceneId) : "")
    || directPaperScene || (suggested ? prettySceneId(suggested.sceneId) : "") || contextualScene;
  const sceneLink = scene === (suggested && prettySceneId(suggested.sceneId))
    ? suggested : scriptSceneForNumber(review, scene);
  const effectiveEpisodes = take.effective_mapping.episode_ids;
  const episode = (isHumanMapping && effectiveEpisodes.length === 1 ? effectiveEpisodes[0] : null)
    ?? sceneLink?.episode
    ?? (!scene && !hasConflict && effectiveEpisodes.length === 1 ? effectiveEpisodes[0] : null);
  const paperShot = paperSuggestionValue(paper, "shot");
  const paperTake = parseTakeNumber(paperSuggestionValue(paper, "take"));
  const hasDirectPaperSuggestion = Boolean(directPaperScene || paperShot || paperTake);
  return {
    script_scene_id: sceneLink?.sceneId ?? "",
    episode,
    scene,
    shot: paperShot,
    take_number: paperTake,
    derivedSource: isHumanMapping ? "映射" : hasDirectPaperSuggestion ? "纸面建议"
      : checked ? "音画" : suggested ? "对白" : contextualScene ? "上下文" : derivedSource(take),
  };
}
