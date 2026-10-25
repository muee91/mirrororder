import { useEffect, useState } from "react";
import { EditorMonitors } from "./EditorMonitors";
import { sourceOptionEnd } from "./timelineSourceMarks";
import type { TimelineWorkbenchProps } from "./timelineWorkbenchProps";

type SourcePanelProps = Pick<TimelineWorkbenchProps,
  "sourceOptions" | "sourceOption" | "chooseSource" | "sourcePosition" | "changeSourcePosition"
  | "baseUrl" | "projectId" | "snapshot" | "sequence" | "selection" | "playhead"
  | "changePlayhead" | "stepPlayhead" | "focusIntent" | "focusLabel" | "onOpenRepair">;

export function TimelineSourcePanel(props: SourcePanelProps) {
  const { sourceOptions, sourceOption, chooseSource, sourcePosition, changeSourcePosition, baseUrl, projectId, snapshot, sequence, selection, playhead, changePlayhead, stepPlayhead, focusIntent, focusLabel, onOpenRepair } = props;
  const [toolsOpen, setToolsOpen] = useState(Boolean(focusIntent?.groupId));

  useEffect(() => {
    if (focusIntent?.groupId) setToolsOpen(true);
  }, [focusIntent?.nonce]);

  if (!snapshot || !sequence) return null;

  return (
    <>
      <details className="timeline-source-view production-panel editorial-source-tools" open={toolsOpen} onToggle={(event) => setToolsOpen(event.currentTarget.open)}>
        <summary><span><strong>素材监看</strong><small>{focusIntent?.groupId ? `当前 ${focusLabel || "Take"} 已带入 Source 上下文` : "核对将要组接或已组接的素材"}</small></span><em>{sourceOptions.length} 个可播放素材</em></summary>
        <div className="editorial-source-body">
          {sourceOption ? (
            <div className="timeline-source-fields">
              <label className="production-field"><span>素材</span><select value={sourceOption.source.source_id} onChange={(event) => { const next = sourceOptions.find((option) => option.source.source_id === event.target.value); if (next) chooseSource(next); }}>{sourceOptions.map((option) => <option value={option.source.source_id} key={option.source.source_id}>{option.label}</option>)}</select></label>
              <span className="timeline-source-range">可用范围 {sourceOption.availableIn}–{sourceOptionEnd(sourceOption)} 帧</span>
            </div>
          ) : <p className="empty-copy">当前剪辑没有可播放素材。先确认本机素材绑定和审阅媒体证据。</p>}
        </div>
      </details>
      <EditorMonitors baseUrl={baseUrl} projectId={projectId} project={snapshot.project} sequence={sequence} selectedClip={selection?.clip ?? null} sourcePreview={sourceOption ? { source: sourceOption.source, frame: sourcePosition, rangeStart: sourceOption.availableIn, rangeEnd: sourceOptionEnd(sourceOption) } : null} playhead={playhead} onPlayheadChange={changePlayhead} onStepFrames={stepPlayhead} onSourceFrameChange={changeSourcePosition} onOpenRepair={onOpenRepair} />
    </>
  );
}
