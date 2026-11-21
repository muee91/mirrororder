import { useEffect, useRef, useState } from "react";
import { errorMessage, HostConnection } from "../../api/host";
import { originalPlaybackUrl } from "../slate/SlateOriginalPlayback";
import type { ProductionSelectionContext } from "./productionNavigation";

interface Props {
  baseUrl: string;
  selection: ProductionSelectionContext;
  snippet?: string;
  onClose: () => void;
  onOpenObject?: () => void;
  onRepair: () => void;
}

interface Source {
  url: string;
  name: string;
  start: number;
  end?: number;
}

async function resolveSource(baseUrl: string, selection: ProductionSelectionContext): Promise<Source | null> {
  const { projectId, groupId, clipId, mediaId, sourceRange } = selection;
  const host = new HostConnection(baseUrl);
  let occurrence = clipId;
  let media = mediaId;
  let name = "";
  let offset = 0;
  let boundary: number | undefined;
  if (groupId) {
    const model = await host.reviewModel(projectId);
    const take = model.take_groups.find((row) => row.group_id === groupId);
    const angle = take?.angles.find((row) => clipId ? row.clip_id === clipId && (!mediaId || mediaId === row.media_id)
      : mediaId ? row.media_id === mediaId : false)
      ?? (!clipId && !mediaId ? take?.angles[0] : undefined);
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

export function EvidencePreview({ baseUrl, selection, snippet, onClose, onOpenObject, onRepair }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    const modal = dialog.current;
    modal?.showModal?.();
    return () => modal?.close?.();
  }, []);

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setSource(null);
    void resolveSource(baseUrl, selection).then((result) => {
      if (active) setSource(result);
    }).catch((reason) => {
      if (active) setError(errorMessage(reason));
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, [baseUrl, selection, retry]);

  return <dialog ref={dialog} className="semantic-search-palette evidence-preview" aria-label="定位媒体证据"
    onCancel={(event) => { event.preventDefault(); onClose(); }}>
    <header><h2>媒体证据</h2><button type="button" className="secondary" onClick={onClose}>关闭</button></header>
    {snippet && <p>{snippet}</p>}
    {loading && <p role="status">正在定位本机媒体…</p>}
    {error && <p role="alert">{error}</p>}
    {source && !error && <>
      <p>{source.name ? `${source.name} · ` : ""}原片 {source.start.toFixed(2)} 秒
        {source.end !== undefined && ` 至 ${source.end.toFixed(2)} 秒`}</p>
      <video ref={videoRef} controls playsInline preload="auto" src={source.url}
        onLoadedMetadata={(event) => {
          const video = event.currentTarget;
          if (Number.isFinite(video.duration) && source.start >= video.duration) {
            setError("证据时间超出了当前原片时长。");
            return;
          }
          if (source.start < video.duration) {
            video.currentTime = source.start;
            void video.play()?.catch(() => undefined);
          }
        }}
        onTimeUpdate={(event) => {
          const video = event.currentTarget;
          if (source.end !== undefined && !video.paused && video.currentTime >= source.end) video.pause();
        }}
        onError={() => setError("无法播放这条证据，请检查媒体是否已连接。")} />
    </>}
    {!loading && !error && !source && <p>这条记录暂无可定位的片段。</p>}
    <footer>
      {source && !error && <button type="button" className="secondary" onClick={() => {
        const video = videoRef.current;
        if (!video) return;
        video.currentTime = source.start;
        void video.play()?.catch(() => undefined);
      }}>重播命中片段</button>}
      {onOpenObject && <button type="button" onClick={onOpenObject}>{selection.recordId ? "打开场记" : "打开素材"}</button>}
      {error && <>
        <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>重试播放</button>
        <button type="button" className="secondary" onClick={onRepair}>检查本机素材</button>
      </>}
    </footer>
  </dialog>;
}
