import { TimelineInitialAssembly } from "./TimelineInitialAssembly";
import { TimelineInspectorPanel } from "./TimelineInspectorPanel";
import { TimelineSourcePanel } from "./TimelineSourcePanel";
import { TimelineStagePanel } from "./TimelineStagePanel";
import { TimelineSuggestionsPanel } from "./TimelineSuggestionsPanel";
import type { TimelineWorkbenchProps } from "./timelineWorkbenchProps";
import { MulticamSyncTimeline } from "./MulticamSyncTimeline";

export function TimelineWorkbenchView(props: TimelineWorkbenchProps) {
  const { baseUrl, message, snapshot, sequence, focusIntent, focusLabel, onOpenDelivery, syncTimeline, onMulticamSync } = props;
  const syncBlocked = Boolean(syncTimeline && !syncTimeline.ready);
  return (
    <section className="timeline-workbench editorial-workbench">
      <header className="production-heading timeline-heading">
        <div>
          <p className="eyebrow">时间线</p>
          <h2>{syncBlocked ? "多机位同步" : syncTimeline?.ready ? "时间线检查" : "组接与导出"}</h2>
          <p className="production-note">{syncBlocked
            ? "导入素材和剧本先在这里建立统一时间轴；同步完成后才能进入后续工作区。"
            : syncTimeline?.ready
              ? "按机位检查素材排列和同步结果；镜序只读展示，不在这里进行帧级剪辑。"
              : "时间线由人工选片组接生成，是唯一正式版本；本页负责核对与导出，精剪在导出后的外部 NLE 完成。"}</p>
        </div>
        <div className="timeline-heading-actions">
          <span className="production-state">{message}</span>
          {!syncBlocked ? <button type="button" onClick={onOpenDelivery}>交付 / 导出</button> : null}
        </div>
      </header>
      {focusIntent?.groupId ? (
        <div className="timeline-focus-context" aria-label="跨工作区当前对象">
          <span>当前对象</span>
          <strong>{focusLabel || "当前 Take"}</strong>
          <small>已从其它工作区带入；时间线会优先定位已有片段，否则定位可播放 Source。</small>
        </div>
      ) : null}
      {syncTimeline ? <MulticamSyncTimeline baseUrl={baseUrl} syncTimeline={syncTimeline} onMulticamSync={onMulticamSync} /> : null}
      {!syncTimeline || syncTimeline.ready ? <>
        <TimelineInitialAssembly {...props} />
        {snapshot && sequence ? <>
          <TimelineStagePanel {...props} />
          <TimelineSourcePanel {...props} />
          <div className="editorial-lower-grid"><TimelineInspectorPanel {...props} /><TimelineSuggestionsPanel {...props} /></div>
          {snapshot.validation.length ? <div className="timeline-validation production-panel">{snapshot.validation.map((issue) => <p key={`${issue.code}-${issue.path}`}><strong>{issue.code}</strong> · {issue.path} · {issue.message}</p>)}</div> : null}
        </> : <div className="timeline-empty"><strong>建立初始顺片后显示组接时间线</strong><p>多机位同步结果已在上方完成检查；确认时间基后再建立本机剪辑。</p></div>}
      </> : null}
    </section>
  );
}
