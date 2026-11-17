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

const SYNC_STEPS = ["确认素材", "计算同步", "建立索引", "检查并交付"] as const;

function stageLabel(phase: MulticamSyncTimeline["phase"], stage: string): string {
  if (phase === "loading") return "正在读取任务状态";
  if (phase === "unavailable") return "无法读取任务状态";
  if (phase === "failed") return "同步任务失败";
  if (phase === "cancelled") return "任务已取消";
  if (phase === "interrupted") return "任务被中断";
  if (phase === "invalid") return "上次同步结果不可用";
  if (phase === "required") return "准备开始同步";
  if (stage === "analysis") return "正在建立媒体身份索引";
  if (stage === "queued") return "任务已排队";
  if (stage === "starting") return "正在启动同步引擎";
  if (stage === "sync") return "正在计算多机位同步";
  return phase === "running" ? "同步任务正在执行" : "等待开始";
}

function activityLabel(value: string | undefined): string {
  if (!value) return "尚未记录";
  const timestamp = new Date(value);
  return Number.isNaN(timestamp.getTime()) ? value : timestamp.toLocaleString("zh-CN");
}

function SyncGate({ syncTimeline, onMulticamSync }: Props) {
  const task = syncTimeline.task;
  const phase = syncTimeline.phase;
  const running = phase === "running";
  const loading = phase === "loading";
  const unreadable = phase === "unavailable";
  const problem = ["failed", "cancelled", "interrupted", "invalid"].includes(phase);
  // The worker reports algorithm checkpoints, not the number of media files
  // processed. Do not turn these counts into an invented overall percentage.
  const rawDone = task?.progress?.done;
  const rawTotal = task?.progress?.total;
  const done = typeof rawDone === "number" && Number.isFinite(rawDone) && rawDone >= 0 ? rawDone : null;
  const total = typeof rawTotal === "number" && Number.isFinite(rawTotal) && rawTotal >= 5 ? rawTotal : null;
  const hasCheckpoints = running && task?.stage === "sync" && done !== null && total !== null && done <= total;
  const stepIndex = task?.stage === "analysis" ? 2 : running ? 1 : 0;

  return (
    <section className="multicam-sync-gate" aria-label="多机位同步任务">
      <header className="multicam-sync-gate-header">
        <div>
          <p className="multicam-sync-kicker">新项目 · 第一步</p>
          <h3>同步音视频，先让剪辑师开工</h3>
          <p>优先完成多机位同步与媒体身份整理。剧本、场记、演员和语义分析可以在交付同步工程后继续。</p>
        </div>
        <span className={`multicam-sync-status is-${phase}`} role="status">
          <span className={`multicam-sync-status-dot is-${phase}`} aria-hidden="true" />
          {stageLabel(phase, task?.stage ?? "")}
        </span>
      </header>
      <div className="multicam-sync-flow" aria-label="制作流程">
        {SYNC_STEPS.map((label, index) => (
          <span className={index === stepIndex ? "is-current" : index < stepIndex ? "is-done" : ""} key={label}>
            <strong>{String(index + 1).padStart(2, "0")}</strong> {label}
          </span>
        ))}
      </div>
      <div className="multicam-sync-gate-body">
        <div className="multicam-sync-live" aria-live="polite">
          <p className="multicam-sync-label">当前任务</p>
          <strong>{task?.message || syncTimeline.message}</strong>
          {hasCheckpoints ? (
            <div className="multicam-sync-progress">
              <div><span>同步算法检查点，不代表全部文件已处理</span><strong>{done} / {total}</strong></div>
              <progress value={done ?? 0} max={total ?? 1} aria-label="同步算法检查点进度" />
            </div>
          ) : running ? (
            <p className="multicam-sync-no-progress">正在执行当前阶段。该步骤还没有可信的逐文件进度，不显示虚假的百分比。</p>
          ) : null}
          {problem && task?.error ? <p className="multicam-sync-error" role="alert">失败原因：{task.error}</p> : null}
          {unreadable ? <p className="multicam-sync-error" role="alert">{syncTimeline.message}</p> : null}
          <div className="multicam-sync-activity">
            {task?.started_at ? <span>开始时间：{activityLabel(task.started_at)}</span> : null}
            {task?.updated_at ? <span>最近任务记录：{activityLabel(task.updated_at)}</span> : null}
            {task?.task_id ? <span title={task.task_id}>任务已记录，可在状态中心查看详情</span> : null}
          </div>
        </div>
        <div className="multicam-sync-action">
          <button type="button" disabled={running || loading || unreadable || !onMulticamSync} onClick={onMulticamSync}>
            {running ? "同步正在运行" : loading ? "检查状态中" : unreadable ? "状态暂不可读" : problem ? "重新执行同步" : "开始多机位同步"}
          </button>
          <p>任务会继续在后台运行。需要查看日志、取消或排查失败，请打开左侧「状态中心」。</p>
          <p>同步未完成时仍可查看「素材」里的媒体清单和本机素材状态；尚未确认的内容不会被伪装成同步成功。</p>
        </div>
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
