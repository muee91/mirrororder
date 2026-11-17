import type { MulticamSyncTimeline as SyncTimeline } from "../../api/syncTimeline";
import { SyncInspectionWorkbench } from "./SyncInspectionWorkbench";
import "./multicam-sync-timeline.css";

interface Props {
  syncTimeline: SyncTimeline;
  baseUrl?: string;
  onMulticamSync?: () => void;
  onInspect?: () => void;
}

const SYNC_STEPS = ["确认素材", "计算同步", "建立索引", "检查并交付"] as const;

function stageLabel(phase: SyncTimeline["phase"], stage: string): string {
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

export function SyncTaskWorkspace({ syncTimeline, onMulticamSync, onInspect }: Props) {
  if (syncTimeline.ready) {
    return (
      <section className="multicam-sync-gate is-complete" aria-label="多机位同步任务">
        <div className="multicam-sync-gate-header"><div>
          <p className="multicam-sync-kicker">01 / 同步任务 · 已完成</p>
          <h3>同步母版已建立，下一步检查音画</h3>
          <p>已识别 {syncTimeline.clip_count} 个视频片段、{syncTimeline.cameras.length} 个机位。任务完成不代表逐帧音画或独立 WAV 已通过验收。</p>
        </div><span className="multicam-sync-status is-completed" role="status">同步任务完成</span></div>
        <div className="multicam-sync-gate-body"><div className="multicam-sync-live">
          <p className="multicam-sync-label">最近任务记录</p>
          <strong>{syncTimeline.task?.message || syncTimeline.message}</strong>
          <div className="multicam-sync-activity">
            {syncTimeline.task?.updated_at ? <span>最近活动：{activityLabel(syncTimeline.task.updated_at)}</span> : null}
          </div>
        </div><div className="multicam-sync-action">
          <button type="button" onClick={onInspect} disabled={!onInspect}>进入同步核对</button>
          <p>核对后在独立的「工程交付」模块查看已有导出文件。</p>
        </div></div>
      </section>
    );
  }
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


export function MulticamSyncTimeline(props: Props) {
  const { syncTimeline } = props;
  if (syncTimeline.phase === "not-required") return null;
  if (!syncTimeline.ready) return <SyncTaskWorkspace {...props} />;
  return <SyncInspectionWorkbench {...props} />;
}
