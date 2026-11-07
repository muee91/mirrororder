import type { ReviewPlayback } from "../../api/host";

/**
 * A Review URL is only a preview authority when the Host has an explicit
 * verified result (or an older snapshot explicitly said available=true).
 * Missing/unknown must remain a state label, never a speculative <video>.
 */
export function canPreviewReviewPlayback(playback: Pick<ReviewPlayback, "state" | "available">): boolean {
  if (playback.state === "verified") return true;
  if (playback.state === "missing" || playback.state === "unknown") return false;
  return playback.available === true;
}
