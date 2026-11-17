import { TimelineInitialAssembly } from "./TimelineInitialAssembly";
import { TimelineInspectorPanel } from "./TimelineInspectorPanel";
import { TimelineSourcePanel } from "./TimelineSourcePanel";
import { TimelineStagePanel } from "./TimelineStagePanel";
import { TimelineSuggestionsPanel } from "./TimelineSuggestionsPanel";
import type { TimelineWorkbenchProps } from "./timelineWorkbenchProps";
import { MulticamSyncTimeline } from "./MulticamSyncTimeline";

export function TimelineWorkbenchView(props: TimelineWorkbenchProps) {
  const {
    baseUrl, message, snapshot, sequence, focusIntent, focusLabel, onOpenDelivery,
    syncTimeline, onMulticamSync, assemblyExpanded = false, assemblyOnly = false, onToggleAssembly,
  } = props;
  const isSyncProject = !assemblyOnly && Boolean(syncTimeline && syncTimeline.phase !== "not-required");
  const syncBlocked = Boolean(isSyncProject && !syncTimeline?.ready);
  // A synchronized master is an independent deliverable, not a mini timeline
  // above the unrelated creative assembly, source and program monitors.
  const showSync = isSyncProject && (!assemblyExpanded || syncBlocked);
  const showEditorial = assemblyOnly || !isSyncProject || (!syncBlocked && assemblyExpanded);

  return (
    <section className="timeline-workbench editorial-workbench">
      <header className="production-heading timeline-heading">
        <div>
          <p className="eyebrow">{showSync ? "同步母版" : "编辑组接"}</p>
          <h2>{showSync ? (syncBlocked ? "多机位同步" : "同步核对与工程交付") : "组接与导出"}</h2>
          <p className="production-note">{showSync
            ? syncBlocked
              ? "先同步视频和同期声；任务阶段、已知进度与失败原因都在这里。检查素材不受阻。"
              : "优先核对原始机位和同步工程，交给剪辑师后再进行场记、剧本和镜头分析。"
            : "人工组接只是外部 NLE 的剪辑起点；分帧精剪在导出后的软件中完成。"}</p>
        </div>
        <div className="timeline-heading-actions">
          {showEditorial ? <span className="production-state">{message}</span> : null}
          {isSyncProject && !syncBlocked && onToggleAssembly ? (
            <button type="button" className="secondary" onClick={onToggleAssembly}>
              {showEditorial ? "返回同步母版" : "进入选片组接"}
            </button>
          ) : null}
          {showEditorial ? <button type="button" onClick={onOpenDelivery}>交付 / 导出</button> : null}
        </div>
      </header>

      {showEditorial && focusIntent?.groupId ? (
        <div className="timeline-focus-context" aria-label="跨工作区当前对象">
          <span>当前对象</span>
          <strong>{focusLabel || "当前 Take"}</strong>
          <small>来自其它工作区的对象会优先定位已有片段，否则定位可播放素材。</small>
        </div>
      ) : null}

      {showSync && syncTimeline ? (
        <MulticamSyncTimeline baseUrl={baseUrl} syncTimeline={syncTimeline} onMulticamSync={onMulticamSync} />
      ) : null}

      {showEditorial ? (
        <>
          <TimelineInitialAssembly {...props} />
          {snapshot && sequence ? (
            <>
              <TimelineStagePanel {...props} />
              <TimelineSourcePanel {...props} />
              <div className="editorial-lower-grid">
                <TimelineInspectorPanel {...props} />
                <TimelineSuggestionsPanel {...props} />
              </div>
              {snapshot.validation.length ? (
                <div className="timeline-validation production-panel">
                  {snapshot.validation.map((issue) => <p key={`${issue.code}-${issue.path}`}><strong>{issue.code}</strong> · {issue.path} · {issue.message}</p>)}
                </div>
              ) : null}
            </>
          ) : <div className="timeline-empty"><strong>建立初始顺片后显示组接时间线</strong><p>请先确认时间基；镜序不在此提供帧级剪辑。</p></div>}
        </>
      ) : null}
    </section>
  );
}
