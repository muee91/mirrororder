import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ReviewAngle } from "../api/host";
import { cameraPresentation } from "../features/media/cameraPresentation";
import { angleSourceWindow } from "./teamModel";

interface Props {
  angle: ReviewAngle;
  mediaUrl: string;
  sourceStart?: number;
  selected?: boolean;
  onSelect?: () => void;
  slateStatus?: string;
}

export function TeamVideoFrame({ angle, mediaUrl, sourceStart, selected, onSelect, slateStatus }: Props) {
  const camera = cameraPresentation(angle.camera);
  const available = angle.playback?.available !== false;
  const videoRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(false);
  const [ratio, setRatio] = useState<number>(9 / 16);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    const node = containerRef.current;
    if (!node || typeof IntersectionObserver !== "function") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          setVisible(true);
          observer.disconnect();
        }
      },
      { rootMargin: "240px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  const { start, end } = angleSourceWindow(angle);
  const targetTime = sourceStart !== undefined ? Math.max(start, Math.min(end, sourceStart)) : start;

  return (
    <button
      ref={containerRef}
      type="button"
      className={`tw-angle-card${selected ? " is-selected" : ""}${!available ? " is-offline" : ""}`}
      data-camera-tone={camera.tone}
      style={{ "--tw-ratio": ratio } as CSSProperties}
      onClick={onSelect}
      title={angle.name}
    >
      <div className="tw-angle-frame">
        {available && !failed && visible ? (
          <video
            ref={videoRef}
            src={mediaUrl}
            preload="metadata"
            muted
            playsInline
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setRatio(video.videoWidth / video.videoHeight);
              }
              const actualEnd = Math.min(end, video.duration || Infinity);
              if (actualEnd > start) {
                const seekTo = targetTime === 0 && video.readyState < 2 ? Math.min(actualEnd / 2, 0.001) : targetTime;
                if (Math.abs(video.currentTime - seekTo) > 0.01) {
                  video.currentTime = seekTo;
                }
              }
            }}
            onError={() => setFailed(true)}
          />
        ) : (
          <div className="tw-angle-placeholder">
            <span>{!available ? "素材离线" : failed ? "预览失败" : "加载中…"}</span>
          </div>
        )}
        <span className="tw-camera-badge" data-camera-tone={camera.tone}>
          {camera.label}
        </span>
        {slateStatus && slateStatus !== "unmarked" ? (
          <span className={`tw-slate-pill is-${slateStatus}`}>
            {slateStatus === "ng" ? "NG" : slateStatus === "partial" ? "部分可用" : "可用"}
          </span>
        ) : null}
      </div>
      <div className="tw-angle-meta">
        <span className="tw-angle-name">{angle.name || "未命名素材"}</span>
      </div>
    </button>
  );
}
