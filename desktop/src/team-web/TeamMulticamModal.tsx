import { useEffect, useRef, useState, type CSSProperties } from "react";
import type { ReviewAngle, ReviewTakeGroup } from "../api/host";
import type { SpeechEvidence } from "../api/speechEvidence";
import { cameraPresentation } from "../features/media/cameraPresentation";
import { teamApi, teamMediaUrl } from "./teamApi";
import { angleSourceWindow, formatClock } from "./teamModel";

interface Props {
  workspaceId: string;
  projectId: string;
  take: ReviewTakeGroup;
  initialClipId?: string | null;
  initialTime?: number;
  onClose: () => void;
  onWatchAngle: (clipId: string, sourceTime: number) => void;
}

function MulticamAngle({
  workspaceId,
  projectId,
  angle,
  listening,
  initialTime,
  onListen,
  onWatchAngle,
}: {
  workspaceId: string;
  projectId: string;
  angle: ReviewAngle;
  listening: boolean;
  initialTime?: number;
  onListen: () => void;
  onWatchAngle: (time: number) => void;
}) {
  const camera = cameraPresentation(angle.camera);
  const videoRef = useRef<HTMLVideoElement>(null);
  const { start, end } = angleSourceWindow(angle);
  const [ratio, setRatio] = useState(9 / 16);
  const [duration, setDuration] = useState<number | null>(null);
  const [position, setPosition] = useState(
    initialTime !== undefined && initialTime >= start && initialTime < end ? initialTime : start,
  );
  const [playing, setPlaying] = useState(false);
  const [speech, setSpeech] = useState<SpeechEvidence | null>(null);
  const available = angle.playback?.available !== false;
  const effectiveEnd = Math.min(end, duration ?? Infinity);
  const url = teamMediaUrl(workspaceId, projectId, angle.clip_id);

  useEffect(() => {
    let active = true;
    void teamApi
      .getSpeechEvidence(workspaceId, projectId, angle.clip_id)
      .then((res) => {
        if (active) setSpeech(res);
      })
      .catch(() => {
        // Speech evidence is optional in LAN preview.
      });
    return () => {
      active = false;
    };
  }, [workspaceId, projectId, angle.clip_id]);

  function seek(next: number): void {
    const video = videoRef.current;
    if (!video) return;
    const clamped = Math.max(start, Math.min(effectiveEnd, next));
    video.currentTime = clamped;
    setPosition(clamped);
  }

  function togglePlay(): void {
    const video = videoRef.current;
    if (!video) return;
    if (!video.paused) {
      video.pause();
      return;
    }
    if (video.currentTime < start || video.currentTime >= effectiveEnd) {
      seek(start);
    }
    void video.play().catch(() => {});
  }

  const segments =
    speech?.status === "available"
      ? speech.segments.filter((seg) => seg.text.trim() && seg.start < effectiveEnd && seg.end > start)
      : [];

  return (
    <article className="tw-mc-angle" data-camera-tone={camera.tone} style={{ "--tw-ratio": ratio } as CSSProperties}>
      <header className="tw-mc-angle-head">
        <span className="tw-camera-badge" data-camera-tone={camera.tone}>
          {camera.label}
        </span>
        <strong title={angle.name}>{angle.name}</strong>
      </header>
      <div className="tw-mc-picture">
        {available ? (
          <video
            ref={videoRef}
            src={url}
            preload="metadata"
            playsInline
            muted={!listening}
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (video.videoWidth > 0 && video.videoHeight > 0) {
                setRatio(video.videoWidth / video.videoHeight);
              }
              setDuration(Number.isFinite(video.duration) ? video.duration : null);
              const actualEnd = Math.min(end, video.duration || Infinity);
              const target = position >= start && position < actualEnd ? position : start;
              const seekTo = target === 0 && video.readyState < 2 ? Math.min(actualEnd / 2, 0.001) : target;
              if (Math.abs(video.currentTime - seekTo) > 0.01) {
                video.currentTime = seekTo;
              }
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              if (video.currentTime < start) video.currentTime = start;
              if (video.currentTime >= effectiveEnd) {
                if (!video.paused) video.pause();
                video.currentTime = effectiveEnd;
              }
              setPosition(video.currentTime);
            }}
            onPlay={() => setPlaying(true)}
            onPause={() => setPlaying(false)}
            onEnded={() => setPlaying(false)}
          />
        ) : (
          <div className="tw-angle-placeholder">素材离线</div>
        )}
      </div>
      {available ? (
        <div className="tw-mc-controls">
          <div className="tw-mc-seek">
            <input
              type="range"
              min={start}
              max={Number.isFinite(effectiveEnd) ? effectiveEnd : start + 1}
              step={0.05}
              value={position}
              onChange={(event) => seek(Number(event.target.value))}
            />
            <span>{formatClock(position)}</span>
          </div>
          <div className="tw-mc-buttons">
            <button type="button" className="tw-btn-secondary" onClick={togglePlay}>
              {playing ? "暂停" : "播放"}
            </button>
            <button
              type="button"
              className={`tw-btn-secondary${listening ? " is-active" : ""}`}
              aria-pressed={listening}
              onClick={onListen}
            >
              {listening ? "正在监听" : "监听"}
            </button>
            <button
              type="button"
              className="tw-btn-secondary"
              onClick={() => onWatchAngle(videoRef.current?.currentTime ?? position)}
            >
              单独看
            </button>
          </div>
        </div>
      ) : null}
      {segments.length > 0 ? (
        <ol className="tw-mc-speech">
          {segments.slice(0, 8).map((seg, idx) => {
            const t = Math.max(start, seg.start);
            return (
              <li key={`${seg.start}-${idx}`}>
                <button type="button" onClick={() => seek(t)}>
                  <time>{formatClock(t)}</time>
                  <span>{seg.text}</span>
                </button>
              </li>
            );
          })}
        </ol>
      ) : null}
    </article>
  );
}

export function TeamMulticamModal({
  workspaceId,
  projectId,
  take,
  initialClipId,
  initialTime,
  onClose,
  onWatchAngle,
}: Props) {
  const [listenClipId, setListenClipId] = useState<string>(
    initialClipId || take.angles.find((a) => a.playback?.available !== false)?.clip_id || take.angles[0]?.clip_id || "",
  );
  const [syncPlaying, setSyncPlaying] = useState(false);
  const [syncPos, setSyncPos] = useState(0);
  const gridRef = useRef<HTMLDivElement>(null);
  const maxDuration = Math.max(1, Number(take.duration || 0) || 1);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  function toggleSyncPlay(): void {
    const videos = [...(gridRef.current?.querySelectorAll("video") ?? [])];
    if (!videos.length) return;
    if (syncPlaying) {
      videos.forEach((v) => v.pause());
      setSyncPlaying(false);
    } else {
      videos.forEach((v) => {
        void v.play().catch(() => {});
      });
      setSyncPlaying(true);
    }
  }

  function seekAll(relativeSec: number): void {
    setSyncPos(relativeSec);
    const videos = [...(gridRef.current?.querySelectorAll("video") ?? [])];
    videos.forEach((v, idx) => {
      const angle = take.angles[idx];
      if (!angle) return;
      const { start, end } = angleSourceWindow(angle);
      const target = Math.max(start, Math.min(end, start + relativeSec));
      v.currentTime = target;
    });
  }

  return (
    <div className="tw-modal-backdrop" role="dialog" aria-modal="true" aria-label="多机位同看">
      <div className="tw-modal tw-multicam-modal">
        <header className="tw-modal-head">
          <div>
            <strong>多机位同看</strong>
            <span>各机位同步齐播，点击「监听」切换同期声</span>
          </div>
          <div className="tw-mc-sync-bar">
            <button type="button" className="tw-btn-primary" onClick={toggleSyncPlay}>
              {syncPlaying ? "同步暂停" : "同步播放"}
            </button>
            <input
              type="range"
              aria-label="多机位同步进度"
              min={0}
              max={maxDuration}
              step={0.05}
              value={syncPos}
              onChange={(e) => seekAll(Number(e.target.value))}
            />
            <span>{formatClock(syncPos)}</span>
          </div>
          <button type="button" className="tw-btn-secondary" onClick={onClose}>
            关闭
          </button>
        </header>
        <div className="tw-mc-grid" ref={gridRef}>
          {take.angles.map((angle) => (
            <MulticamAngle
              key={angle.clip_id}
              workspaceId={workspaceId}
              projectId={projectId}
              angle={angle}
              listening={angle.clip_id === listenClipId}
              initialTime={angle.clip_id === initialClipId ? initialTime : undefined}
              onListen={() => setListenClipId(angle.clip_id)}
              onWatchAngle={(time) => {
                onClose();
                onWatchAngle(angle.clip_id, time);
              }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
