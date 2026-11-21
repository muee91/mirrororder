import { useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/host";
import { playEvidenceSource, resolveEvidenceSource, type ResolvedEvidenceSource } from "./evidenceSource";
import type { ProductionSelectionContext } from "./productionNavigation";

interface Props {
  baseUrl: string;
  selection: ProductionSelectionContext;
  snippet?: string;
  onClose: () => void;
  onOpenObject?: () => void;
  onRepair: () => void;
}

export function EvidencePreview({ baseUrl, selection, snippet, onClose, onOpenObject, onRepair }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const [source, setSource] = useState<ResolvedEvidenceSource | null>(null);
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
    void resolveEvidenceSource(baseUrl, selection).then((result) => {
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
          if (!playEvidenceSource(event.currentTarget, source)) setError("证据时间超出了当前原片时长。");
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
        if (!playEvidenceSource(video, source)) setError("证据时间超出了当前原片时长。");
      }}>重播命中片段</button>}
      {onOpenObject && <button type="button" onClick={onOpenObject}>{selection.recordId ? "打开场记" : "打开素材"}</button>}
      {error && <>
        <button type="button" className="secondary" onClick={() => setRetry(value => value + 1)}>重试播放</button>
        <button type="button" className="secondary" onClick={onRepair}>检查本机素材</button>
      </>}
    </footer>
  </dialog>;
}
