import { TimelineInitialAssembly } from "./TimelineInitialAssembly";
import { TimelineInspectorPanel } from "./TimelineInspectorPanel";
import { TimelineSourcePanel } from "./TimelineSourcePanel";
import { TimelineStagePanel } from "./TimelineStagePanel";
import { TimelineSuggestionsPanel } from "./TimelineSuggestionsPanel";

export function TimelineWorkbenchView(props: { [key: string]: any }) {
  const { message, snapshot, sequence } = props;
  return (
    <section className="timeline-workbench editorial-workbench">
      <header className="production-heading timeline-heading">
        <div><p className="eyebrow">剪辑</p><h2>剪辑工作台</h2><p className="production-note">初始顺片只负责建立起点；从建立后开始，这条时间线就是唯一剪辑版本。</p></div>
        <span className="production-state">{message}</span>
      </header>
      <TimelineInitialAssembly {...props} />
      {snapshot && sequence ? <>
        <TimelineStagePanel {...props} />
        <TimelineSourcePanel {...props} />
        <div className="editorial-lower-grid"><TimelineInspectorPanel {...props} /><TimelineSuggestionsPanel {...props} /></div>
        {snapshot.validation.length ? <div className="timeline-validation production-panel">{snapshot.validation.map((issue: any) => <p key={`${issue.code}-${issue.path}`}><strong>{issue.code}</strong> · {issue.path} · {issue.message}</p>)}</div> : null}
      </> : <div className="production-panel timeline-empty"><strong>尚未建立本机剪辑</strong><p>上方“初始顺片”是建立剪辑的起点。建立后，所有换镜次、多机位、修剪和手工插入都会继续写入同一条持久化时间线。</p></div>}
    </section>
  );
}
