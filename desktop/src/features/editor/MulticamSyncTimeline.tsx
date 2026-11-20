import { useEffect, useState } from "react";
import { DesktopClient, type MediaBindingSummary } from "../../api/desktop";
import type { MulticamSyncTimeline as SyncTimeline } from "../../api/syncTimeline";
import { SyncInspectionWorkbench } from "./SyncInspectionWorkbench";
import "./multicam-sync-timeline.css";

interface Props {
  syncTimeline: SyncTimeline;
  baseUrl?: string;
  onMulticamSync?: () => void;
  onInspect?: () => void;
  onCancel?: () => void;
  onRepair?: () => void;
  onOpenStatus?: () => void;
  command?: "start" | "cancel" | "";
  submissionError?: string;
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

export function SyncTaskWorkspace({ syncTimeline, baseUrl, onMulticamSync, onInspect, onCancel, onRepair, onOpenStatus, command, submissionError }: Props) {
  const [sources, setSources] = useState<MediaBindingSummary | null>(null);
  const [sourcesUnreadable, setSourcesUnreadable] = useState(false);
  useEffect(() => {
    if (!baseUrl || !syncTimeline.project_id) return;
    let active = true;
    void new DesktopClient(baseUrl).mediaBinding(syncTimeline.project_id).then(({ summary }) => {
      if (active) { setSources(summary); setSourcesUnreadable(false); }
    }).catch(() => { if (active) setSourcesUnreadable(true); });
    return () => { active = false; };
  }, [baseUrl, syncTimeline.project_id, syncTimeline.phase]);
  if (syncTimeline.ready && syncTimeline.phase === "completed") {
    return (
      <section className="multicam-sync-gate is-complete" aria-label="多机位同步任务">
        <div className="multicam-sync-gate-header"><div>
          <h3>同步母版已建立，下一步检查音画</h3>
          <p>已识别 {syncTimeline.clip_count} 个视频片段、{syncTimeline.cameras.length} 个机位。进入核对页检查音画与待处理异常。</p>
        </div><span className="multicam-sync-status is-completed" role="status">同步任务完成</span></div>
        <div className="multicam-sync-gate-body"><div className="multicam-sync-live">
          <p className="multicam-sync-label">最近任务记录</p>
          <strong>{syncTimeline.task?.message || syncTimeline.message}</strong>
          <div className="multicam-sync-activity">
            {syncTimeline.task?.updated_at ? <span>最近活动：{activityLabel(syncTimeline.task.updated_at)}</span> : null}
          </div>
        </div><div className="multicam-sync-action">
          <button type="button" onClick={onInspect} disabled={!onInspect}>进入同步核对</button>
          {onOpenStatus && <button type="button" className="secondary" onClick={onOpenStatus}>任务详情</button>}
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
          <h3>同步原始视频与同期录音</h3>
          <p>{sourcesUnreadable ? "无法读取原始目录状态"
            : sources?.unavailable_roots?.length ? `${sources.unavailable_roots.length} 个原始目录不可访问`
            : sources ? `${sources.roots.length} 个已登记目录` : "正在读取原始目录"}</p>
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
          <strong>{unreadable ? "等待状态恢复" : task?.message || syncTimeline.message}</strong>
          {submissionError && <p className="multicam-sync-error" role="alert">{submissionError}</p>}
          {task?.cancel_requested && <p role="status">已请求取消，正在等待安全中断点。</p>}
          {hasCheckpoints ? (
            <div className="multicam-sync-progress">
              <div><span>同步算法检查点，不代表全部文件已处理</span><strong>{done} / {total}</strong></div>
              <progress value={done ?? 0} max={total ?? 1} aria-label="同步算法检查点进度" />
            </div>
          ) : running ? (
            <p className="multicam-sync-no-progress">当前阶段正在运行。</p>
          ) : null}
          {problem && task?.error ? <p className="multicam-sync-error" role="alert">失败原因：{task.error}</p> : null}
          {unreadable ? <p className="multicam-sync-error" role="alert">{syncTimeline.message}</p> : null}
          <div className="multicam-sync-activity">
            {task?.started_at ? <span>开始时间：{activityLabel(task.started_at)}</span> : null}
            {task?.updated_at ? <span>最近任务记录：{activityLabel(task.updated_at)}</span> : null}
            {task?.task_id ? <span title={task.task_id}>已记录后台任务</span> : null}
          </div>
        </div>
        <div className="multicam-sync-action">
          <button type="button" disabled={Boolean(command) || running || loading || unreadable || !onMulticamSync} onClick={onMulticamSync}>
            {command === "start" ? "正在提交…" : running ? "同步正在运行" : loading ? "检查状态中" : unreadable ? "状态暂不可读" : problem || submissionError ? "重新执行同步" : "开始多机位同步"}
          </button>
          {running && task && onCancel && <button type="button" className="secondary" disabled={Boolean(command) || task.cancel_requested}
            onClick={onCancel}>{task.cancel_requested || command === "cancel" ? "正在取消…" : "取消同步"}</button>}
          {task && onOpenStatus && <button type="button" className="secondary" onClick={onOpenStatus}>任务详情</button>}
          {onRepair && <button type="button" className="secondary" onClick={onRepair}>检查本机素材</button>}
          {onInspect && <button type="button" className="secondary" onClick={onInspect}>查看上次有效母版</button>}
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
