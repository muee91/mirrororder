import type { MediaHealthState } from "../../components/StatusIndicators";

export interface MediaHealthFacts {
  indexed: boolean;
  playable: boolean;
  state?: "verified" | "missing" | "unknown" | string;
  playbackFailed?: boolean;
}

export function mediaHealthState({ indexed, playable, state, playbackFailed = false }: MediaHealthFacts): MediaHealthState {
  if (playbackFailed) return "unsupported";
  if (state === "missing") return "offline";
  if (state === "unknown") return "unknown";
  if (playable) return "ready";
  return indexed ? "identity_missing" : "index_pending";
}
