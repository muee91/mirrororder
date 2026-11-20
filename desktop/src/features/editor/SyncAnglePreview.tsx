import { useCallback, useEffect, useRef, useState, type RefObject, type VideoHTMLAttributes } from "react";

const PLAYBACK_DRIFT_SECONDS = 0.06;
const SEEK_TOLERANCE_SECONDS = 0.000001;

export interface SyncPreviewClock extends Pick<VideoHTMLAttributes<HTMLVideoElement>,
  "onLoadedMetadata" | "onSeeked" | "onPlay" | "onPause" | "onTimeUpdate" | "onEnded" | "onError"> {
  video: RefObject<HTMLVideoElement | null>;
}

interface Props {
  src: string;
  sourceTime: number;
  playing: boolean;
  clock?: SyncPreviewClock;
}

export function SyncAnglePreview({ src, sourceTime, playing, clock }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [hasMetadata, setHasMetadata] = useState(false);
  const [failed, setFailed] = useState(false);
  const clockRef = clock?.video;
  const attach = useCallback((video: HTMLVideoElement | null) => {
    if (clockRef && (video || clockRef.current === videoRef.current)) clockRef.current = video;
    videoRef.current = video;
  }, [clockRef]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !hasMetadata || failed || clockRef) return;
    if (!playing && !video.paused) video.pause();

    const lastTime = Number.isFinite(video.duration) ? Math.max(0, video.duration - SEEK_TOLERANCE_SECONDS) : sourceTime;
    const wanted = Math.min(sourceTime, lastTime);
    const tolerance = playing && !video.paused ? PLAYBACK_DRIFT_SECONDS : SEEK_TOLERANCE_SECONDS;
    if ((!playing || !video.seeking) && Math.abs(video.currentTime - wanted) > tolerance) {
      video.currentTime = wanted;
    }
    if (playing && video.paused) {
      void video.play().catch((error: unknown) => {
        if (video !== videoRef.current || (error instanceof DOMException && error.name === "AbortError")) return;
        if (video.error) setFailed(true);
      });
    }
  }, [clockRef, failed, hasMetadata, playing, sourceTime]);

  return <>
    <video className="multicam-sync-video" ref={attach} src={src} aria-hidden="true"
      data-listening={clock ? "" : undefined} muted={!clock} hidden={failed} playsInline preload="auto"
      onLoadedMetadata={event => { setHasMetadata(true); clock?.onLoadedMetadata?.(event); }}
      onError={event => { setFailed(true); clock?.onError?.(event); }}
      onSeeked={clock?.onSeeked} onPlay={clock?.onPlay} onPause={clock?.onPause}
      onTimeUpdate={clock?.onTimeUpdate} onEnded={clock?.onEnded} />
    {failed && <span className="multicam-sync-angle-placeholder">无法预览</span>}
  </>;
}
