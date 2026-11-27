import type { ReviewTakeGroup } from "../../api/host";
import type { SemanticSearchResult } from "../../api/semantic";
import { matchesScriptSpeech } from "../material-script/scriptSpeech";

export function normalizedQuery(text: string): string {
  return text.normalize("NFKC").toLowerCase().replace(/\s*[-‐‑‒–—−]\s*/g, "-").trim();
}

export function browseEpisodeIds(take: ReviewTakeGroup, slateEpisode?: number | null, includeCandidates = false): Set<number> {
  const mapping = take.effective_mapping;
  const mapped = mapping.episode_ids.filter((episode) => Number.isSafeInteger(episode) && episode > 0);
  const episodes = new Set(mapped.length ? mapped : slateEpisode && slateEpisode > 0 ? [slateEpisode] : []);
  if (includeCandidates) {
    for (const episode of take.context.episode_ids) if (episode > 0) episodes.add(episode);
    for (const candidate of take.candidates) {
      for (const episode of candidate.episode_ids) if (episode > 0) episodes.add(episode);
      for (const episode of candidate.context_episodes) if (episode > 0) episodes.add(episode);
    }
  }
  return episodes;
}

export function isScriptSpeechHit(hit: SemanticSearchResult, clauses: readonly string[]): boolean {
  if (hit.source !== "speech" || hit.metadata.precision !== "asr_segment"
    || !hit.clip_id || !Number.isFinite(hit.start) || !Number.isFinite(hit.end)
    || hit.start < 0 || hit.end <= hit.start) return false;
  return matchesScriptSpeech(hit.snippet, clauses);
}
