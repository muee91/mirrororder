import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { PlaybackState, ReviewAngle } from "../../api/host";
import type { SlateAttachment } from "../../api/production";
import { canPreviewReviewPlayback } from "./mediaPlaybackProjection";
import { reviewAspectStyle } from "./useReviewAspect";
import { cameraPresentation } from "./cameraPresentation";
import { observeNearViewport, useVideoDecodeSlot } from "./nearViewport";
import { StudioIcon } from "../../components/StudioIcons";
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
  availabilityState?: PlaybackState;
  playbackUrl?: string;
  sourceStart?: number;
  duplicateCount?: number;
}

export function mediaCardFromAngle(angle: ReviewAngle, attachment?: SlateAttachment | null): MirrorOrderMediaCardModel {
  const state = angle.playback.state;
  const available = state === "verified"
    ? true
    : state === "missing" || angle.playback.available === false
      ? false
      : state === "unknown"
        ? undefined
        : angle.playback.available;
  return {
    id: angle.clip_id,
    mediaId: angle.media_id,
    camera: attachment?.camera || angle.camera || "—",
    name: attachment?.display_name || angle.name || angle.clip_id,
    duration: angle.duration,
    shotType: attachment?.shot_type || angle.shot_type || "unknown",
    sourceRole: attachment?.source_role || angle.coverage_role || "",
    available,
    availabilityState: state,
    playbackUrl: canPreviewReviewPlayback(angle.playback) ? angle.playback.url : undefined,
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
  frameOnly?: boolean;
  frameAspect?: number;
  frameDescriptionId?: string;
  onFrameAspect?: (ratio: number) => void;
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

export function formatCompactMediaName(name: string): string {
  const trimmed = name.trim();
  if (!trimmed) return "";
  const stem = trimmed.replace(/\.(mov|mp4|mxf|wav|m4v|r3d|braw|avi|mkv|mpg|mpeg)$/i, "");
  return stem;
}

const compactPreviewOptions = { rootMargin: "48px 96px" };
function observeCompactPreview(element: Element, listener: (visible: boolean) => void): () => void {
  return observeNearViewport(element, listener, compactPreviewOptions.rootMargin,
    (dispatch) => new IntersectionObserver(dispatch, compactPreviewOptions));
}

export const MirrorOrderMediaCard = memo(function MirrorOrderMediaCard({
  model,
  selected = false,
  preferred = false,
  compact = false,
  frameOnly = false,
  frameAspect,
  frameDescriptionId,
  onFrameAspect,
  showPreview = false,
  onSelect,
  onPrefer,
}: Props) {
  const cardRef = useRef<HTMLElement | null>(null);
  const setCard = useCallback((element: HTMLElement | null) => { cardRef.current = element; }, []);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const posterRef = useRef<HTMLCanvasElement>(null);
  const [compactPreviewActive, setCompactPreviewActive] = useState(!compact);
  const [previewState, setPreviewState] = useState<"loading" | "ready" | "failed">("loading");
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
    return observeCompactPreview(element, setCompactPreviewActive);
  }, [compact, frameOnly]);

  const unavailable = model.availabilityState === "missing" || model.available === false;
  const unknown = model.availabilityState === "unknown";
  const previewWanted = Boolean((showPreview || (compact && compactPreviewActive)) && model.playbackUrl && !unavailable && !unknown);
  const [decodeSlotGranted, markDecodeSettled] = useVideoDecodeSlot(previewWanted, `${model.sourceStart ?? 0}:${model.playbackUrl ?? ""}`);
  const previewEnabled = previewWanted && decodeSlotGranted;
  const label = useMemo(() => [camera.label, model.name, compact && (!model.shotType || model.shotType === "unknown") ? "" : shotLabel(model.shotType)].filter(Boolean).join(" · "), [camera.label, compact, model.name, model.shotType]);

  useLayoutEffect(() => {
    setPreviewState("loading");
    const video = videoRef.current;
    if (!video || !previewEnabled) return;
    const start = Number(model.sourceStart ?? 0);
    const target = Number.isFinite(start) && start >= 0 ? start : 0;
    const measure = () => {
      if (video.videoWidth && video.videoHeight) onFrameAspect?.(video.videoWidth / video.videoHeight);
    };
    const paintFrame = () => {
      const poster = posterRef.current;
      if (!poster || video.readyState < 2 || !video.videoWidth || !video.videoHeight || video.seeking) return;
      const scale = Math.min(1, 640 / Math.max(video.videoWidth, video.videoHeight));
      poster.width = Math.max(1, Math.round(video.videoWidth * scale));
      poster.height = Math.max(1, Math.round(video.videoHeight * scale));
      const context = poster.getContext("2d");
      if (context) {
        try {
          context.drawImage(video, 0, 0, poster.width, poster.height);
          poster.dataset.painted = "true";
        } catch {
          // The decoder can release its current frame before drawing completes.
          delete poster.dataset.painted;
        }
      }
    };
    if (posterRef.current) delete posterRef.current.dataset.painted;
    const markReady = () => {
      if (posterRef.current && (video.seeking || video.readyState < 2)) return;
      measure();
      paintFrame();
      setPreviewState("ready");
      markDecodeSettled();
    };
    const seek = () => {
      measure();
      if (target <= 0) {
        // At zero a paused decoder can report HAVE_CURRENT_DATA while its first
        // frame is still transparent. Only the poster needs a decoded sample.
        if (video.readyState >= 2 && (!posterRef.current || video.currentTime > 0)) {
          markReady();
          return;
        }
        const probeTime = Number.isFinite(video.duration) && video.duration > 0.12 ? 0.04 : 0.001;
        if (!video.seeking) {
          try { video.currentTime = probeTime; } catch { /* metadata may not be seekable yet */ }
        }
        return;
      }
      if (!video.seeking && Math.abs(video.currentTime - target) <= 0.04 && video.readyState >= 2) {
        markReady();
        return;
      }
      try { video.currentTime = target; } catch { /* metadata may not be seekable yet */ }
    };
    const loadedData = () => {
      if (target > 0) return;
      if (posterRef.current) seek();
      else markReady();
    };
    video.addEventListener("resize", measure);
    video.addEventListener("loadedmetadata", seek);
    video.addEventListener("loadeddata", loadedData);
    video.addEventListener("seeked", markReady);
    if (video.readyState >= 1) seek();
    return () => {
      video.removeEventListener("resize", measure);
      video.removeEventListener("loadedmetadata", seek);
      video.removeEventListener("loadeddata", loadedData);
      video.removeEventListener("seeked", markReady);
    };
  }, [model.playbackUrl, model.sourceStart, previewEnabled, markDecodeSettled, onFrameAspect]);

  const frameState = unavailable ? "missing" : unknown || !model.playbackUrl ? "unknown" : previewEnabled ? previewState : "waiting";
  const frameLabels = { missing: "文件缺失", unknown: "原片待核对", failed: "无法载入预览", loading: "正在读取预览", waiting: "等待预览", ready: "" };
  const frame = (
    <span className="mo-media-thumb" style={reviewAspectStyle(frameAspect)}
      data-preview-state={frameState}
      data-frame-shape={frameAspect === undefined ? undefined : frameAspect < 1 ? "portrait" : frameAspect > 1 ? "landscape" : "square"}
      ref={frameOnly ? setCard : undefined} aria-hidden={frameDescriptionId ? undefined : true}>
        {frameOnly && <span id={frameDescriptionId} className="mo-media-preview-message">{frameLabels[frameState]}</span>}
        {previewEnabled ? (
          <>
            {!frameOnly && <span className="mo-media-preview-fallback"><StudioIcon name="film" size={18} /></span>}
            <video ref={videoRef} className={previewState === "ready" ? "is-ready" : ""} src={model.playbackUrl}
              preload="metadata" muted playsInline tabIndex={-1} aria-hidden="true"
              onError={() => { setPreviewState("failed"); markDecodeSettled(); }} />
            {frameOnly && onFrameAspect && <canvas className="mo-review-poster" aria-hidden="true" ref={posterRef} />}
          </>
        ) : !frameOnly && (
          <span className={unavailable ? "is-missing" : unknown ? "is-unknown" : "mo-media-preview-fallback"}>
            {unavailable ? "缺失" : unknown ? "待检" : <StudioIcon name="film" size={18} />}
          </span>
        )}
        <span className="mo-media-camera-badge" data-camera-tone={camera.tone}>{camera.label}</span>
    </span>
  );
  if (frameOnly) return frame;

  const supportText = unavailable ? "设备缺失" : unknown ? "状态未知" : (!compact ? sourceRoleLabel(model.sourceRole) : "");
  const content = (
    <>
      {frame}
      <div className="mo-media-copy">
        <div className="mo-media-topline">
          <span className="mo-media-name" title={model.name}>{compact ? formatCompactMediaName(model.name) : model.name}</span>
          <span className="mo-media-count-slot">{model.duplicateCount && model.duplicateCount > 1 ? `×${model.duplicateCount}` : ""}</span>
        </div>
        {(!compact || (model.shotType && model.shotType !== "unknown")) ? <span className={`mo-media-shot ${!model.shotType || model.shotType === "unknown" ? "is-unknown" : ""}`}>{shotLabel(model.shotType)}</span> : null}
        <div className="mo-media-meta">
          <span>{seconds(model.duration) || "时长—"}</span>
          <span className={`mo-media-preference-label ${preferred ? "is-preferred" : ""}`}>{preferred ? "首选" : ""}</span>
        </div>
        <span className={`mo-media-support ${unavailable ? "is-missing" : unknown ? "is-unknown" : ""}`} title={supportText}>{supportText}</span>
      </div>
      <span className={`mo-media-selected-slot ${selected ? "is-visible" : ""}`} aria-hidden={!selected} aria-label={selected ? "已选择" : undefined}>✓</span>
    </>
  );

  return (
    <div
      ref={setCard}
      className={`mo-media-card ${compact ? "is-compact" : "is-inspector"} ${selected ? "is-selected" : ""} ${unavailable ? "is-missing" : unknown ? "is-unknown" : ""}`}
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
});
