import { TimelineInitialAssembly } from "./TimelineInitialAssembly";
import { TimelineInspectorPanel } from "./TimelineInspectorPanel";
import { TimelineSourcePanel } from "./TimelineSourcePanel";
import { TimelineStagePanel } from "./TimelineStagePanel";
import { TimelineSuggestionsPanel } from "./TimelineSuggestionsPanel";
import type { TimelineWorkbenchProps } from "./timelineWorkbenchProps";

export function TimelineWorkbenchView(props: TimelineWorkbenchProps) {
  const { message, snapshot, sequence, focusIntent, focusLabel, onOpenDelivery } = props;
  return (
    <section className="timeline-workbench editorial-workbench">
      <header className="production-heading timeline-heading">
        <div>
          <p className="eyebrow">时间线</p>
          <h2>组接与导出</h2>
          <p className="production-note">时间线由人工选片组接生成，是唯一正式版本；本页负责核对与导出，精剪在导出后的外部 NLE 完成。</p>
        </div>
        <div className="timeline-heading-actions">
          <span className="production-state">{message}</span>
          <button type="button" onClick={onOpenDelivery}>交付 / 导出</button>
        </div>
      </header>
      {focusIntent?.groupId ? (
        <div className="timeline-focus-context" aria-label="跨工作区当前对象">
          <span>当前对象</span>
          <strong>{focusLabel || "当前 Take"}</strong>
          <small>已从其它工作区带入；时间线会优先定位已有片段，否则定位可播放 Source。</small>
        </div>
      ) : null}
      <TimelineInitialAssembly {...props} />
      {snapshot && sequence ? <>
        <TimelineStagePanel {...props} />
        <TimelineSourcePanel {...props} />
        <div className="editorial-lower-grid"><TimelineInspectorPanel {...props} /><TimelineSuggestionsPanel {...props} /></div>
        {snapshot.validation.length ? <div className="timeline-validation production-panel">{snapshot.validation.map((issue) => <p key={`${issue.code}-${issue.path}`}><strong>{issue.code}</strong> · {issue.path} · {issue.message}</p>)}</div> : null}
      </> : <div className="production-panel timeline-empty"><strong>尚未建立本机时间线</strong><p>上方“初始顺片”根据人工选片建立唯一的本机时间线。建立后即可核对片段与多机位，并交付 / 导出到外部 NLE 继续精剪。</p></div>}
    </section>
  );
}
