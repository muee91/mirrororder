import type { ReviewModelPayload } from "../../api/host";
import type { SlateRecord } from "../../api/production";
import { prettySceneId } from "../slate/slateTakeFields";
import { browseEpisodeIds, normalizedQuery } from "./reviewFinderEvidence";

export type ReviewSortOrder = "script" | "shooting" | "relevance" | "attention";
export type ReviewTakeFields = Pick<SlateRecord, "episode" | "script_scene_id" | "scene" | "shot" | "take_number">;

type ScriptScene = { episode: number; id: string; order: number };
export type ReviewTakePlace = { episode: number | null; sceneId: string; scene: string; sceneOrder: number | null };

export function reviewTakePlaces(model: ReviewModelPayload, fieldsById: ReadonlyMap<string, ReviewTakeFields>) {
  const scenesByEpisode = new Map<number, Map<string, ScriptScene>>();
  const scenesBySegment = new Map<string, ScriptScene>();
  for (const { episode, scenes } of model.episodes) {
    const aliases = new Map<string, ScriptScene>();
    scenes.forEach((scene, order) => {
      const entry = { episode, id: scene.scene_id, order };
      aliases.set(normalizedQuery(scene.scene_id), entry);
      aliases.set(normalizedQuery(prettySceneId(scene.scene_id)), entry);
      for (const block of scene.script_blocks) scenesBySegment.set(block.segment_id, entry);
    });
    scenesByEpisode.set(episode, aliases);
  }

  return new Map(model.take_groups.map((take): [string, ReviewTakePlace] => {
    const fields = fieldsById.get(take.group_id);
    const episodeIds = browseEpisodeIds(take, fields?.episode);
    const slateEpisode = fields?.episode;
    const episode = slateEpisode && episodeIds.has(slateEpisode) ? slateEpisode : [...episodeIds][0] ?? null;
    const aliases = scenesByEpisode.get(episode ?? 0);
    const mapped = new Set(take.effective_mapping.script_segment_ids.flatMap((id) => {
      const scene = scenesBySegment.get(id);
      return scene?.episode === episode ? [scene] : [];
    }));
    const slateScene = fields?.scene.trim() ?? "";
    const linked = aliases?.get(normalizedQuery(fields?.script_scene_id ?? ""))
      ?? aliases?.get(normalizedQuery(slateScene));
    const scene = linked ?? (mapped.size === 1 ? [...mapped][0] : undefined);
    return [take.group_id, {
      episode,
      sceneId: scene?.id ?? "",
      scene: slateScene || (scene ? prettySceneId(scene.id) : ""),
      sceneOrder: scene?.order ?? null,
    }];
  }));
}

const missing = Number.MAX_SAFE_INTEGER;
const collator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function compareReviewTakeNumber(left?: ReviewTakeFields, right?: ReviewTakeFields): number {
  return (left?.take_number ?? missing) - (right?.take_number ?? missing);
}

export function compareReviewStory(left: ReviewTakePlace | undefined, right: ReviewTakePlace | undefined,
  leftFields: ReviewTakeFields | undefined, rightFields: ReviewTakeFields | undefined): number {
  const leftScene = left?.sceneId || left?.scene || "";
  const rightScene = right?.sceneId || right?.scene || "";
  const leftShot = leftFields?.shot.trim() || "";
  const rightShot = rightFields?.shot.trim() || "";
  return (left?.episode ?? missing) - (right?.episode ?? missing)
    || (left?.sceneOrder ?? missing) - (right?.sceneOrder ?? missing)
    || Number(!leftScene) - Number(!rightScene)
    || collator.compare(leftScene, rightScene)
    || Number(!leftShot) - Number(!rightShot)
    || collator.compare(leftShot, rightShot)
    || compareReviewTakeNumber(leftFields, rightFields);
}

export function reviewSceneHeading(place: ReviewTakePlace | undefined): string {
  if (!place?.episode && !place?.scene) return "未归集";
  return [place.episode ? `第 ${place.episode} 集` : "", place.scene ? `${place.scene} 场` : "未标场号"]
    .filter(Boolean).join(" · ");
}
