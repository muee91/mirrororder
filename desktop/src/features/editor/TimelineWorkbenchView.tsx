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
          <h2>时间线</h2>
          <p className="production-note">这里是唯一正式剪辑版本。初始顺片和自动建议都修改同一条本机时间线，不会形成第二套剪辑。</p>
        </div>
        <div className="timeline-heading-actions">
          <span className="production-state">{message}</span>
          <button type="button" className="secondary" onClick={onOpenDelivery}>交付 / 导出</button>
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
      </> : <div className="production-panel timeline-empty"><strong>尚未建立本机剪辑</strong><p>上方“初始顺片”只是建立本机时间线的起点。建立后，换镜次、多机位、修剪、手工插入与交付都围绕同一份持久化时间线继续。</p></div>}
    </section>
  );
}
