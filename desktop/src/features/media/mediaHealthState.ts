import type { MediaHealthState } from "../../components/StatusIndicators";

export interface MediaHealthFacts {
  indexed: boolean;
  playable: boolean;
  playbackFailed?: boolean;
}

export function mediaHealthState({ indexed, playable, playbackFailed = false }: MediaHealthFacts): MediaHealthState {
  if (playbackFailed) return "unsupported";
  if (playable) return "ready";
  return indexed ? "identity_missing" : "index_pending";
}
