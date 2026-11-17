import { isTauri } from "@tauri-apps/api/core";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import {
  SyncTimelineClient,
  type MulticamSyncClip,
  type MulticamSyncTimeline,
  type MulticamSyncTrack,
  type SyncDeliveryArtifacts,
} from "../../api/syncTimeline";
import { PlatformClient } from "../../api/platform";

interface Props {
  syncTimeline: MulticamSyncTimeline;
  baseUrl?: string;
  onMulticamSync?: () => void;
  showDelivery?: boolean;
  onOpenDelivery?: () => void;
}

const ZOOM_LEVELS = [1, 2, 4, 8, 16, 32, 64, 128] as const;
const RULER = [0, 0.25, 0.5, 0.75, 1] as const;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function secondsLabel(value: number): string {
  const seconds = Math.max(0, Math.floor(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function cameraStyle(camera: string): CSSProperties {
  const palette: Record<string, string> = {
    A: "#4cb6a5", B: "#d88a4a", C: "#9b88db",
    D: "#609ee8", E: "#d47caf", F: "#a0b754",
  };
  const name = camera.trim().toUpperCase();
  const index = /^[A-Z]$/.test(name) ? name.charCodeAt(0) - 65 : -1;
  const color = palette[name] || (index >= 0 ? `hsl(${Math.round(index * 137.508) % 360} 55% 58%)` : "#81909d");
  return { "--camera-color": color } as CSSProperties;
}

function activeAt(track: MulticamSyncTrack | undefined, position: number): MulticamSyncClip | undefined {
  return track?.clips.find((clip) =>
    position >= clip.timeline_start && position < clip.timeline_start + clip.duration
  );
}

interface TrackProps {
  track: MulticamSyncTrack;
  start: number;
  window: number;
  position: number;
  selectedTrackId: string;
  onChoose: (trackId: string, clip: MulticamSyncClip) => void;
}

function SyncTrack({ track, start, window, position, selectedTrackId, onChoose }: TrackProps) {
  const color = cameraStyle(track.camera);
  const visible = track.clips.filter((clip) =>
    clip.timeline_start < start + window && clip.timeline_start + clip.duration > start
  );
  const cursor = (position - start) / window * 100;
  return (
    <div className="multicam-sync-track" style={color}>
      <div className="multicam-sync-track-label">
        <strong>{track.camera}</strong>
        <span>{track.clip_count} 个片段</span>
      </div>
      <div className="multicam-sync-track-lane" aria-label={`${track.label} 同步轨道`}>
        {visible.map((clip) => {
          const left = clamp((clip.timeline_start - start) / window * 100, 0, 100);
          const right = clamp((clip.timeline_start + clip.duration - start) / window * 100, 0, 100);
          return (
            <button
              className={`multicam-sync-clip${selectedTrackId === track.track_id && activeAt(track, position) === clip ? " is-selected" : ""}`}
              key={`${track.track_id}:${clip.clip_id}:${clip.timeline_start}`}
              type="button"
              style={{ left: `${left}%`, width: `${Math.max(0, right - left)}%` }}
              title={`${clip.name}\n${clip.day} · ${secondsLabel(clip.timeline_start)} · ${clip.timecode || "无时码"}`}
              onClick={() => onChoose(track.track_id, clip)}
            ><span>{clip.name}</span></button>
          );
        })}
        {cursor >= 0 && cursor <= 100 ? <span className="multicam-sync-playhead-line" style={{ left: `${cursor}%` }} aria-hidden="true" /> : null}
      </div>
    </div>
  );
}

export function SyncInspectionWorkbench({ syncTimeline, baseUrl, onMulticamSync, showDelivery = true, onOpenDelivery }: Props) {
  const duration = Math.max(syncTimeline.duration_seconds, 0.1);
  const [position, setPosition] = useState(0);
  const [zoom, setZoom] = useState(1);
  const [trackId, setTrackId] = useState(syncTimeline.tracks[0]?.track_id ?? "");
  const [playbackError, setPlaybackError] = useState("");
  const [artifacts, setArtifacts] = useState<SyncDeliveryArtifacts | null>(null);
  const [artifactError, setArtifactError] = useState("");
  const [revealBusy, setRevealBusy] = useState("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const platform = useMemo(() => new PlatformClient(), []);
  const selectedTrack = syncTimeline.tracks.find((track) => track.track_id === trackId) ?? syncTimeline.tracks[0];
  const clip = activeAt(selectedTrack, position);

  const windowDuration = Math.max(0.1, duration / zoom);
  const start = clamp(position - windowDuration / 2, 0, Math.max(0, duration - windowDuration));
  const playbackUrl = baseUrl && clip?.media_clip_id
    ? `${baseUrl.replace(/\/+$/, "")}/api/v1/projects/${encodeURIComponent(syncTimeline.project_id)}/media/${encodeURIComponent(clip.media_clip_id)}`
    : "";
  const sourceTime = clip ? clamp(position - clip.timeline_start, 0, Math.max(0, clip.duration - 0.04)) : 0;

  useEffect(() => {
    setPosition(0);
    setZoom(1);
    setTrackId(syncTimeline.tracks[0]?.track_id ?? "");
  }, [syncTimeline.project_id]);

  useEffect(() => {
    setPlaybackError("");
  }, [playbackUrl]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !clip || video.readyState < 1) return;
    if (Math.abs(video.currentTime - sourceTime) > 0.3) video.currentTime = sourceTime;
  }, [sourceTime, playbackUrl, clip]);

  useEffect(() => {
    if (!showDelivery || !baseUrl) return;
    let cancelled = false;
    setArtifacts(null);
    setArtifactError("");
    void new SyncTimelineClient(baseUrl).readArtifacts(syncTimeline.project_id).then((value) => {
      if (!cancelled) setArtifacts(value);
    }).catch((error: unknown) => {
      if (!cancelled) setArtifactError(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [baseUrl, showDelivery, syncTimeline.project_id]);

  function chooseClip(nextTrackId: string, next: MulticamSyncClip): void {
    setTrackId(nextTrackId);
    if (position < next.timeline_start || position >= next.timeline_start + next.duration) {
      setPosition(next.timeline_start);
    }
  }

  async function reveal(path: string, target: string): Promise<void> {
    setRevealBusy(target);
    setArtifactError("");
    try {
      await platform.reveal(path);
    } catch (error) {
      setArtifactError(error instanceof Error ? error.message : String(error));
    } finally {
      setRevealBusy("");
    }
  }

  function jumpBy(seconds: number): void {
    setPosition((current) => clamp(Math.round((current + seconds) * 10) / 10, 0, duration));
  }

  return (
    <section className="multicam-sync-inspection" aria-label="多机位同步时间线检查">
      <header className="multicam-sync-inspection-heading">
        <div>
          <h3>同步母版 · 轨道核对</h3>
          <p>选中片段可预览原始视频；在同一时间点切换机位进行比对。这里不修改已交付的同步偏移。</p>
        </div>
        <div className="multicam-sync-inspection-meta">
          <span>{syncTimeline.clip_count} 个视频</span>
          <span>{syncTimeline.cameras.join(" / ")} 机位</span>
          <span>总长 {secondsLabel(duration)}</span>
          {onMulticamSync ? <button type="button" className="secondary" onClick={onMulticamSync}>重新同步</button> : null}
          {onOpenDelivery ? <button type="button" onClick={onOpenDelivery}>进入工程交付</button> : null}
        </div>
      </header>

      <div className="multicam-sync-controls">
        <div className="multicam-sync-time-controls">
          <button type="button" className="secondary" onClick={() => jumpBy(-1)} aria-label="后退一秒">−1s</button>
          <strong aria-live="polite">{secondsLabel(position)}</strong>
          <button type="button" className="secondary" onClick={() => jumpBy(1)} aria-label="前进一秒">+1s</button>
        </div>
        <label htmlFor="multicam-sync-zoom">时间轴缩放</label>
        <select id="multicam-sync-zoom" value={zoom} onChange={(event) => setZoom(Number(event.target.value))}>
          {ZOOM_LEVELS.map((level) => <option value={level} key={level}>{level}×</option>)}
        </select>
      </div>
      <div className="multicam-sync-cursor-control">
        <label htmlFor="multicam-sync-cursor">同步母版播放头</label>
        <input id="multicam-sync-cursor" type="range" min="0" max={duration} step="0.1"
          value={position} onChange={(event) => setPosition(Number(event.target.value))} />
        <span>{secondsLabel(duration)}</span>
      </div>
      <div className="multicam-sync-track-list">
        <div className="multicam-sync-ruler" aria-hidden="true">
          <span>机位</span>
          <div>{RULER.map((part) => <span key={part} style={{ left: `${part * 100}%` }}>{secondsLabel(start + part * windowDuration)}</span>)}</div>
        </div>
        {syncTimeline.tracks.map((track) => (
          <SyncTrack key={track.track_id} track={track} start={start} window={windowDuration}
            position={position} selectedTrackId={selectedTrack?.track_id ?? ""} onChoose={chooseClip} />
        ))}
      </div>
      <div className="multicam-sync-monitor-grid">
        <div className="multicam-sync-monitor">
          <div className="multicam-sync-monitor-heading">
            <strong>原始素材预览</strong><span>{selectedTrack?.label || "未选择机位"}</span>
          </div>
          <div className="multicam-sync-angle-switch" aria-label="当前播放头可用机位">
            {syncTimeline.tracks.filter((track) => activeAt(track, position)).map((track) => (
              <button type="button" key={track.track_id}
                aria-pressed={track.track_id === selectedTrack?.track_id}
                onClick={() => setTrackId(track.track_id)}
                className={track.track_id === selectedTrack?.track_id ? "is-active" : "secondary"}
              >{track.camera} 机</button>
            ))}
          </div>
          {clip && playbackUrl ? (
            <video
              key={playbackUrl} className="multicam-sync-video" ref={videoRef}
              src={playbackUrl} controls playsInline preload="metadata"
              onLoadedMetadata={(event) => { event.currentTarget.currentTime = sourceTime; }}
              onTimeUpdate={(event) => {
                const next = clamp(clip.timeline_start + event.currentTarget.currentTime, 0, duration);
                setPosition((current) => Math.abs(current - next) >= 0.25 ? next : current);
              }}
              onError={() => setPlaybackError("媒体读取或解码失败，请检查本机绑定或该视频编码。")}
            />
          ) : <div className="multicam-sync-preview-empty">
            {clip ? "此片段尚未建立无歧义的素材身份，无法安全预览。请先检查素材绑定。"
              : "当前时间该机位没有片段；可选择其它机位或移动播放头。"}
          </div>}
          {playbackError ? <p role="alert" className="multicam-sync-error">{playbackError}</p> : null}
        </div>
        <div className="multicam-sync-details">
          <strong>当前片段</strong>
          {clip ? (
            <dl>
              <dt>文件</dt><dd>{clip.name}</dd>
              <dt>机位 / 拍摄日</dt><dd>{clip.camera} / {clip.day}</dd>
              <dt>同步起点</dt><dd>{secondsLabel(clip.timeline_start)}</dd>
              <dt>片段时长</dt><dd>{secondsLabel(clip.duration)}</dd>
              <dt>源内位置</dt><dd>{secondsLabel(sourceTime)}</dd>
              <dt>原始时码</dt><dd>{clip.timecode || "未记录"}</dd>
              <dt>媒体匹配</dt><dd>{clip.media_clip_id ? "已关联项目媒体身份" : "待核实"}</dd>
            </dl>
          ) : <p>请在时间线选择片段，或移动播放头到有素材的位置。</p>}
          <p className="multicam-sync-detail-note">本页为逐片预览与秒级定位；尚未实现同步偏移的安全写入、帧级对轨或独立 WAV 核对。</p>
        </div>
      </div>

      {showDelivery ? <div className="multicam-sync-export">
        <div className="multicam-sync-export-heading">
          <div><strong>同步工程 · 已生成文件</strong><p>复用同步引擎的现有导出文件，不需要先完成场记或选片。</p></div>
          <span>外部 NLE 导入仍需实测</span>
        </div>
        {artifacts ? (
          <div className="multicam-sync-export-list">
            {artifacts.artifacts.map((item) => (
              <div className="multicam-sync-export-item" key={item.target}>
                <div><strong>{item.label}</strong><span>{item.format} · {item.filename}</span></div>
                <button type="button" className="secondary"
                  disabled={!item.available || !isTauri() || Boolean(revealBusy)}
                  onClick={() => void reveal(item.local_path, item.target)}
                >{revealBusy === item.target ? "打开中…" : item.available ? "显示工程文件" : "尚未生成"}</button>
              </div>
            ))}
          </div>
        ) : <p className="multicam-sync-export-hint">{artifactError ? "读取交付清单失败，请检查 Host 连接。" : "正在检查同步引擎生成的交付文件…"}</p>}
        {artifactError ? <p role="alert" className="multicam-sync-error">{artifactError}</p> : null}
        <p className="multicam-sync-export-hint">多轨可导入不等于原生多机位可切换；剪映版本兼容及四款剪辑软件的实际导入尚未验收。缺少文件时不要把工程标记为已交付。</p>
      </div> : null}
    </section>
  );
}
