import { HostConnection } from "../../api/host";
import { originalPlaybackUrl } from "../slate/SlateOriginalPlayback";
import type { ProductionSelectionContext } from "./productionNavigation";

export interface ResolvedEvidenceSource {
  url: string;
  name: string;
  start: number;
  end?: number;
}

export async function resolveEvidenceSource(
  baseUrl: string,
  { projectId, groupId, clipId, mediaId, sourceRange }: ProductionSelectionContext,
): Promise<ResolvedEvidenceSource | null> {
  const host = new HostConnection(baseUrl);
  let occurrence = clipId;
  let media = mediaId;
  let name = "";
  let offset = 0;
  let boundary: number | undefined;
  if (groupId) {
    const model = await host.reviewModel(projectId);
    const take = model.take_groups.find((row) => row.group_id === groupId);
    const angle = clipId || mediaId
      ? take?.angles.find((row) => (!clipId || row.clip_id === clipId) && (!mediaId || row.media_id === mediaId))
      : take?.angles[0];
    if (!angle) throw new Error("证据所指的源片段已变化，请重新检查当前 Take。");
    occurrence = angle.clip_id;
    media = angle.media_id || mediaId;
    name = angle.name || angle.camera;
    if (!sourceRange || sourceRange.basis === "take") {
      offset = angle.playback?.source_start ?? angle.source_start ?? 0;
      boundary = angle.playback?.source_end ?? undefined;
    }
  }
  if (!occurrence) return null;
  if (sourceRange?.basis === "take" && !groupId) throw new Error("这个证据缺少 Take，无法换算到原片时间。");
  const url = media && /^M_[0-9a-f]{24}$/.test(media)
    ? originalPlaybackUrl(baseUrl, projectId, { clipId: occurrence, mediaId: media, selectionKey: occurrence })
    : host.mediaUrl(projectId, occurrence);
  if (!url) throw new Error("这条媒体证据需要从本机 Host 打开。");
  const start = offset + (sourceRange?.start ?? 0);
  if (boundary !== undefined && boundary <= start) throw new Error("证据时间超出了当前片段范围。");
  const end = sourceRange?.end === undefined ? boundary : Math.min(boundary ?? Infinity, offset + sourceRange.end);
  return { url, name, start, end };
}

export function playEvidenceSource(video: HTMLVideoElement, source: ResolvedEvidenceSource): boolean {
  if (Number.isFinite(video.duration) && source.start >= video.duration) return false;
  video.currentTime = source.start;
  void video.play()?.catch(() => undefined);
  return true;
}
