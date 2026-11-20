import type { SyncRecordingPlacement } from "../../api/syncTimeline";
import type { FrameRate } from "../../api/timeline";

export function recordingKey(row: SyncRecordingPlacement): string {
  return JSON.stringify([row.media_id, row.at]);
}

/** Read-only correspondence between the delivered master and a WAV source. */
export function recordingSecondsAtMasterFrame(
  row: SyncRecordingPlacement | null,
  masterFrame: number,
  rate: FrameRate | null,
): number | null {
  if (!row || !rate || !Number.isFinite(rate.numerator) || !Number.isFinite(rate.denominator)
    || rate.numerator <= 0 || rate.denominator <= 0 || !Number.isFinite(masterFrame)
    || !Number.isFinite(row.at) || !Number.isFinite(row.source) || !Number.isFinite(row.frames)
    || row.frames <= 0 || masterFrame < row.at || masterFrame >= row.at + row.frames) return null;
  const sourceFrame = row.source + masterFrame - row.at;
  return sourceFrame >= 0 ? sourceFrame * rate.denominator / rate.numerator : null;
}

/** When linked, advance to a WAV covering the playhead rather than playing an unrelated file. */
export function recordingForMasterFrame(
  rows: readonly SyncRecordingPlacement[],
  masterFrame: number,
  preferredKey: string,
  linked: boolean,
): SyncRecordingPlacement | null {
  const preferred = rows.find((row) => recordingKey(row) === preferredKey) ?? null;
  const covers = (row: SyncRecordingPlacement) => masterFrame >= row.at && masterFrame < row.at + row.frames;
  const current = rows.find(covers) ?? null;
  return linked ? (preferred && covers(preferred) ? preferred : current ?? preferred ?? rows[0] ?? null)
    : preferred ?? current ?? rows[0] ?? null;
}

/** Paused scrubbing is exact; running playback tolerates media-element scheduling jitter. */
export function shouldSeekRecording(actual: number, target: number, playing: boolean): boolean {
  return !Number.isFinite(actual) || !Number.isFinite(target)
    || Math.abs(actual - target) > (playing ? 0.12 : 0.001);
}
