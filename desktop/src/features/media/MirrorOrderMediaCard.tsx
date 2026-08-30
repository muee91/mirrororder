import { useEffect, useMemo, useRef } from "react";
import type { ReviewAngle } from "../../api/host";
import type { SlateAttachment } from "../../api/production";
import "./mirrororder-media-card.css";

export interface MirrorOrderMediaCardModel {
  id: string;
  mediaId: string;
  camera: string;
  name: string;
  duration?: number;
  shotType?: string;
  sourceRole?: string;
  available?: boolean;
  playbackUrl?: string;
  sourceStart?: number;
  duplicateCount?: number;
}

export function mediaCardFromAngle(angle: ReviewAngle, attachment?: SlateAttachment | null): MirrorOrderMediaCardModel {
  return {
    id: angle.clip_id,
    mediaId: angle.media_id,
    camera: attachment?.camera || angle.camera || "—",
    name: attachment?.display_name || angle.name || angle.clip_id,
    duration: angle.duration,
    shotType: attachment?.shot_type || angle.shot_type || "unknown",
    sourceRole: attachment?.source_role || angle.coverage_role || "",
    available: angle.playback.available !== false,
    playbackUrl: angle.playback.url,
    sourceStart: angle.playback.source_start ?? angle.source_start ?? 0,
  };
}

export function mediaCardFromAttachment(attachment: SlateAttachment): MirrorOrderMediaCardModel {
  return {
    id: attachment.clip_id || attachment.media_id,
    mediaId: attachment.media_id,
    camera: attachment.camera || "—",
    name: attachment.display_name || attachment.clip_id || attachment.media_id,
    shotType: attachment.shot_type || "unknown",
    sourceRole: attachment.source_role || "",
  };
}

interface Props {
  model: MirrorOrderMediaCardModel;
  selected?: boolean;
  preferred?: boolean;
  compact?: boolean;
  showPreview?: boolean;
  onSelect?: (id: string) => void;
  onPrefer?: (id: string) => void;
}

function seconds(value?: number): string {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "";
  return value >= 60 ? `${Math.floor(value / 60)}:${String(Math.floor(value % 60)).padStart(2, "0")}` : `${value.toFixed(1)}s`;
}

function shotLabel(value?: string): string {
  if (!value || value === "unknown") return "景别—";
  return `景别${value}`;
}

export function MirrorOrderMediaCard({
  model,
  selected = false,
  preferred = false,
  compact = false,
  showPreview = false,
  onSelect,
  onPrefer,
}: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  // Swift Golden compact cards always carried a real source thumbnail. In the
  // WebView we use the already-authorized local playback descriptor and seek a
  // muted metadata-only video to source_start; no new media authority is made.
  const previewEnabled = Boolean((compact || showPreview) && model.playbackUrl && model.available !== false);
  const label = useMemo(() => [model.camera, model.name, shotLabel(model.shotType)].filter(Boolean).join(" · "), [model]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !previewEnabled) return;
    const seek = () => {
      const start = Number(model.sourceStart ?? 0);
      if (Number.isFinite(start) && start >= 0) {
        try { video.currentTime = start; } catch { /* metadata may not be seekable yet */ }
      }
    };
    video.addEventListener("loadedmetadata", seek);
    if (video.readyState >= 1) seek();
    return () => video.removeEventListener("loadedmetadata", seek);
  }, [model.sourceStart, previewEnabled]);

  const content = (
    <>
      <div className="mo-media-thumb" aria-hidden="true">
        {previewEnabled ? (
          <video ref={videoRef} src={model.playbackUrl} preload="metadata" muted playsInline tabIndex={-1} />
        ) : (
          <span className={model.available === false ? "is-missing" : ""}>{model.available === false ? "▧" : model.camera || "▶"}</span>
        )}
        <span className="mo-media-camera-badge">{model.camera || "—"}</span>
      </div>
      <div className="mo-media-copy">
        <div className="mo-media-topline">
          <span className="mo-media-name" title={model.name}>{model.name}</span>
          {model.duplicateCount && model.duplicateCount > 1 ? <span className="mo-media-count">×{model.duplicateCount}</span> : null}
        </div>
        <span className={`mo-media-shot ${!model.shotType || model.shotType === "unknown" ? "is-unknown" : ""}`}>{shotLabel(model.shotType)}</span>
        <div className="mo-media-meta">
          <span>{seconds(model.duration) || "时长—"}</span>
          <span className={preferred ? "is-preferred" : ""}>{preferred ? "首选" : "非首选"}</span>
        </div>
        {!compact && model.sourceRole ? <span className="mo-media-role">{model.sourceRole}</span> : null}
        {model.available === false ? <span className="mo-media-missing">当前设备缺失</span> : null}
      </div>
      {selected ? <span className="mo-media-selected" aria-label="已选择">✓</span> : null}
    </>
  );

  return (
    <div className={`mo-media-card ${compact ? "is-compact" : "is-inspector"} ${selected ? "is-selected" : ""} ${model.available === false ? "is-missing" : ""}`} aria-label={label}>
      {onSelect ? (
        <button type="button" className="mo-media-select" onClick={() => onSelect(model.id)} aria-pressed={selected}>{content}</button>
      ) : <div className="mo-media-select">{content}</div>}
      {onPrefer ? (
        <button type="button" className={`mo-media-prefer ${preferred ? "is-active" : ""}`} onClick={(event) => { event.stopPropagation(); onPrefer(model.id); }} title={preferred ? "取消场记首选机位" : "设为场记首选机位"} aria-pressed={preferred}>★</button>
      ) : null}
    </div>
  );
}
