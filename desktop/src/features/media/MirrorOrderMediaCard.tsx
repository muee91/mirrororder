import { useEffect, useMemo, useRef, useState } from "react";
import type { ReviewAngle } from "../../api/host";
import type { SlateAttachment } from "../../api/production";
import { cameraPresentation } from "./cameraPresentation";
import "./mirrororder-media-card.css";
import "./camera-presentation.css";

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

const SHOT_VALUE_LABELS: Record<string, string> = {
  wide: "大远景",
  full: "全景",
  medium: "中景",
  medium_closeup: "中近景",
  closeup: "近景",
  extreme_closeup: "大特写",
  big_closeup: "特写",
  insert: "插入镜头",
};

const SOURCE_ROLE_LABELS: Record<string, string> = {
  sync_camera: "同步机位",
  aerial: "航拍",
  broll: "空镜 / B-roll",
  gopro: "GoPro",
  insert: "细节 / Insert",
  custom: "自定义",
};

function shotLabel(value?: string): string {
  if (!value || value === "unknown") return "景别—";
  return SHOT_VALUE_LABELS[value] ?? `景别${value}`;
}

function sourceRoleLabel(value?: string): string {
  if (!value) return "";
  return SOURCE_ROLE_LABELS[value] ?? value;
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
  const cardRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [compactPreviewActive, setCompactPreviewActive] = useState(!compact);
  const [previewReady, setPreviewReady] = useState(false);
  const camera = useMemo(() => cameraPresentation(model.camera), [model.camera]);

  // Compact cards only instantiate a decoder surface close to the viewport.
  // The card keeps a stable camera identity and geometry while preview is dormant.
  useEffect(() => {
    if (!compact) {
      setCompactPreviewActive(true);
      return;
    }
    const element = cardRef.current;
    if (!element || typeof IntersectionObserver === "undefined") {
      setCompactPreviewActive(true);
      return;
    }
    const observer = new IntersectionObserver((entries) => {
      const visible = entries.some((entry) => entry.isIntersecting || entry.intersectionRatio > 0);
      setCompactPreviewActive(visible);
    }, { rootMargin: "48px 96px" });
    observer.observe(element);
    return () => observer.disconnect();
  }, [compact]);

  const previewEnabled = Boolean((showPreview || (compact && compactPreviewActive)) && model.playbackUrl && model.available !== false);
  const label = useMemo(() => [camera.label, model.name, shotLabel(model.shotType)].filter(Boolean).join(" · "), [camera.label, model.name, model.shotType]);

  useEffect(() => {
    setPreviewReady(false);
  }, [model.playbackUrl, model.sourceStart, previewEnabled]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !previewEnabled) return;
    const start = Number(model.sourceStart ?? 0);
    const target = Number.isFinite(start) && start >= 0 ? start : 0;
    const markReady = () => setPreviewReady(true);
    const seek = () => {
      if (target <= 0) {
        if (video.readyState >= 2) markReady();
        return;
      }
      if (Math.abs(video.currentTime - target) <= 0.04 && video.readyState >= 2) {
        markReady();
        return;
      }
      try { video.currentTime = target; } catch { /* metadata may not be seekable yet */ }
    };
    const loadedData = () => { if (target <= 0) markReady(); };
    video.addEventListener("loadedmetadata", seek);
    video.addEventListener("loadeddata", loadedData);
    video.addEventListener("seeked", markReady);
    if (video.readyState >= 1) seek();
    return () => {
      video.removeEventListener("loadedmetadata", seek);
      video.removeEventListener("loadeddata", loadedData);
      video.removeEventListener("seeked", markReady);
    };
  }, [model.sourceStart, previewEnabled]);

  const supportText = model.available === false ? "设备缺失" : (!compact ? sourceRoleLabel(model.sourceRole) : "");

  const content = (
    <>
      <div className="mo-media-thumb" aria-hidden="true">
        {previewEnabled ? (
          <>
            <span className="mo-media-preview-fallback">{camera.label}</span>
            <video ref={videoRef} className={previewReady ? "is-ready" : ""} src={model.playbackUrl} preload="metadata" muted playsInline tabIndex={-1} />
          </>
        ) : (
          <span className={model.available === false ? "is-missing" : ""}>{model.available === false ? "▧" : camera.label}</span>
        )}
        <span className="mo-media-camera-badge" data-camera-tone={camera.tone}>{camera.label}</span>
      </div>
      <div className="mo-media-copy">
        <div className="mo-media-topline">
          <span className="mo-media-name" title={model.name}>{model.name}</span>
          <span className="mo-media-count-slot">{model.duplicateCount && model.duplicateCount > 1 ? `×${model.duplicateCount}` : ""}</span>
        </div>
        <span className={`mo-media-shot ${!model.shotType || model.shotType === "unknown" ? "is-unknown" : ""}`}>{shotLabel(model.shotType)}</span>
        <div className="mo-media-meta">
          <span>{seconds(model.duration) || "时长—"}</span>
          <span className={`mo-media-preference-label ${preferred ? "is-preferred" : ""}`}>{preferred ? "首选" : ""}</span>
        </div>
        <span className={`mo-media-support ${model.available === false ? "is-missing" : ""}`} title={supportText}>{supportText}</span>
      </div>
      <span className={`mo-media-selected-slot ${selected ? "is-visible" : ""}`} aria-hidden={!selected} aria-label={selected ? "已选择" : undefined}>✓</span>
    </>
  );

  return (
    <div
      ref={cardRef}
      className={`mo-media-card ${compact ? "is-compact" : "is-inspector"} ${selected ? "is-selected" : ""} ${model.available === false ? "is-missing" : ""}`}
      data-camera-tone={camera.tone}
      aria-label={label}
    >
      {onSelect ? (
        <button type="button" className="mo-media-select" onClick={() => onSelect(model.id)} aria-label={`选择 ${label}`} aria-pressed={selected}>{content}</button>
      ) : <div className="mo-media-select">{content}</div>}
      {onPrefer ? (
        <button type="button" className={`mo-media-prefer ${preferred ? "is-active" : ""}`} onClick={(event) => { event.stopPropagation(); onPrefer(model.id); }} title={preferred ? "取消场记首选机位" : "设为场记首选机位"} aria-label={preferred ? `取消 ${camera.label} 场记首选` : `设 ${camera.label} 为场记首选`} aria-pressed={preferred}>★</button>
      ) : null}
    </div>
  );
}
