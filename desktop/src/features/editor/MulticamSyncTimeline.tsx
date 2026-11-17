import type { CSSProperties } from "react";
import type { MulticamSyncTimeline, MulticamSyncTrack } from "../../api/syncTimeline";
import "./multicam-sync-timeline.css";

interface Props {
  syncTimeline: MulticamSyncTimeline;
  onMulticamSync?: () => void;
}

function cameraClass(camera: string): string {
  const value = camera.trim().toUpperCase();
  if (/^[A-Z]$/.test(value)) return `camera-${value.toLowerCase()}`;
  return "camera-other";
}

function cameraStyle(camera: string): CSSProperties {
  const value = camera.trim().toUpperCase();
  const palette: Record<string, string> = {
    A: "#4cb6a5", B: "#d88a4a", C: "#9b88db",
    D: "#609ee8", E: "#d47caf", F: "#a0b754",
  };
  const index = /^[A-Z]$/.test(value) ? value.charCodeAt(0) - 65 : -1;
  const color = palette[value] || (index >= 0 ? `hsl(${Math.round(index * 137.508) % 360} 55% 58%)` : "#81909d");
  return { "--camera-color": color } as CSSProperties;
}

function secondsLabel(value: number): string {
  const seconds = Math.max(0, Math.round(value));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours > 0
    ? `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`;
}

function trackSummary(track: MulticamSyncTrack): string {
  return `${track.label} · ${track.clip_count} 个片段`;
}

function SyncGate({ syncTimeline, onMulticamSync }: Props) {
  const running = syncTimeline.phase === "running";
  return (
    <section className="multicam-sync-gate" aria-label="多机位同步前置步骤">
      <div className="multicam-sync-gate-copy">
        <p className="multicam-sync-kicker">时间线前置</p>
        <h3>先完成多机位同步</h3>
        <p>原始素材和剧本必须先建立统一的时间顺序。同步完成后，才能检查轨道，并解锁素材、剧本和审阅。</p>
        <div className="multicam-sync-flow" aria-label="制作流程">
          <span>导入素材 + 剧本</span><b>→</b><strong>多机位同步</strong><b>→</b><span>时间线检查</span><b>→</b><span>素材 / 剧本 / 审阅</span>
        </div>
      </div>
      <div className="multicam-sync-gate-action">
        <span className={`multicam-sync-status-dot is-${syncTimeline.phase}`} aria-hidden="true" />
        <span>{syncTimeline.message}</span>
        <button type="button" disabled={running || !onMulticamSync} onClick={onMulticamSync}>
          {running ? "同步处理中" : syncTimeline.phase === "completed" ? "重新同步素材" : "开始多机位同步"}
        </button>
      </div>
    </section>
  );
}

function TrackRow({ track, duration }: { track: MulticamSyncTrack; duration: number }) {
  const tone = cameraClass(track.camera);
  return (
    <div className={`multicam-sync-track ${tone}`} style={cameraStyle(track.camera)}>
      <div className="multicam-sync-track-label">
        <strong>{track.camera === "?" ? "?" : track.camera}</strong>
        <span>{trackSummary(track)}</span>
      </div>
      <div className="multicam-sync-track-lane" role="list" aria-label={trackSummary(track)}>
        {track.clips.map((clip) => {
          const left = Math.min(100, Math.max(0, (clip.timeline_start / duration) * 100));
          const width = Math.max(0.24, Math.min(100 - left, (clip.duration / duration) * 100));
          return (
            <span
              className="multicam-sync-clip"
              key={`${track.track_id}:${clip.clip_id}:${clip.timeline_start}`}
              role="listitem"
              style={{ left: `${left}%`, width: `${width}%` }}
              title={`${clip.name}\n${clip.day} · ${secondsLabel(clip.timeline_start)}–${secondsLabel(clip.timeline_start + clip.duration)} · ${clip.timecode || "无时码"}`}
            >
              <span>{clip.name}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export function MulticamSyncTimeline(props: Props) {
  const { syncTimeline } = props;
  if (syncTimeline.phase === "not-required") return null;
  if (!syncTimeline.ready) return <SyncGate {...props} />;

  const duration = Math.max(1, syncTimeline.duration_seconds);
  const ruler = [0, 0.25, 0.5, 0.75, 1];
  return (
    <section className="multicam-sync-inspection" aria-label="多机位同步时间线检查">
      <header className="multicam-sync-inspection-heading">
        <div>
          <h3>多机位同步检查</h3>
          <p>这里只读展示素材在统一时间轴上的排列，不提供剪辑操作。</p>
        </div>
        <div className="multicam-sync-inspection-meta">
          <span>{syncTimeline.clip_count} 个素材</span>
          <span>{syncTimeline.cameras.join(" / ")} 机位</span>
          <span>总时长 {secondsLabel(duration)}</span>
          {props.onMulticamSync ? <button type="button" className="secondary" onClick={props.onMulticamSync}>重新同步</button> : null}
        </div>
      </header>
      <div className="multicam-sync-legend" aria-label="机位颜色图例">
        {syncTimeline.tracks.map((track) => <span className={cameraClass(track.camera)} style={cameraStyle(track.camera)} key={track.track_id}><i aria-hidden="true" />{track.label}</span>)}
      </div>
      <div className="multicam-sync-ruler" aria-hidden="true">
        <span />
        <div>{ruler.map((point) => <span key={point} style={{ left: `${point * 100}%` }}>{secondsLabel(duration * point)}</span>)}</div>
      </div>
      <div className="multicam-sync-track-list">
        {syncTimeline.tracks.map((track) => <TrackRow duration={duration} key={track.track_id} track={track} />)}
      </div>
    </section>
  );
}
