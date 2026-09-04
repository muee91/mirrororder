import { EditorMonitors } from "./EditorMonitors";
import { sourceOptionEnd } from "./timelineSourceMarks";
import { frameLabel, localizedEditorialText } from "./timelineWorkbenchSupport";

export function TimelineSourcePanel(props: { [key: string]: any }) {
  const { sourceOptions, sourceOption, chooseSource, sourceIn, setSourceInPrecisely, sourceDuration, setSourceDuration, sourcePosition, changeSourcePosition, markInAtCursor, markOutAtCursor, sourceOut, sourceRangeError, playhead, videoInsertBlocked, audioInsertBlocked, audioTargetTrackId, busy, editFromSource, editAudioFromSource, baseUrl, projectId, snapshot, sequence, selection, changePlayhead, stepPlayhead } = props;
  return (
    <>
      <details className="timeline-source-edit production-panel editorial-source-tools">
        <summary><span><strong>素材监看与插入</strong><small>需要手工补镜头、补音频或精确设入出点时使用</small></span><em>{sourceOptions.length} 个可播放素材</em></summary>
        <div className="editorial-source-body">
          {sourceOption ? <>
            <div className="timeline-source-fields">
              <label className="production-field"><span>素材</span><select value={sourceOption.source.source_id} onChange={(event) => { const next = sourceOptions.find((option: any) => option.source.source_id === event.target.value); if (next) chooseSource(next); }}>{sourceOptions.map((option: any) => <option value={option.source.source_id} key={option.source.source_id}>{option.label}</option>)}</select></label>
              <label className="production-field"><span>源入点</span><input type="number" min={0} step={1} value={sourceIn} onChange={(event) => setSourceInPrecisely(Number(event.target.value) || 0)} /></label>
              <label className="production-field"><span>时长</span><input type="number" min={1} step={1} value={sourceDuration} onChange={(event) => setSourceDuration(Math.max(1, Math.round(Number(event.target.value) || 1)))} /></label>
            </div>
            <div className="timeline-source-cursor">
              <span>素材游标 {frameLabel(sourcePosition)}</span><button type="button" className="secondary" onClick={() => changeSourcePosition(sourcePosition - 1)}>−1f</button><button type="button" className="secondary" onClick={() => changeSourcePosition(sourcePosition + 1)}>+1f</button><button type="button" className="secondary" onClick={markInAtCursor}>设为入点 <kbd>I</kbd></button><button type="button" className="secondary" onClick={markOutAtCursor}>设为出点 <kbd>O</kbd></button><span>入 {frameLabel(sourceIn)} · 出 {frameLabel(sourceOut)}</span>
            </div>
            <div className="proposal-warnings">
              <span>可用范围 {frameLabel(sourceOption.availableIn)}–{frameLabel(sourceOptionEnd(sourceOption))} · 目标 {frameLabel(playhead)}</span>
              {sourceRangeError ? <span>⚠️ {localizedEditorialText(sourceRangeError)}</span> : null}
              {videoInsertBlocked ? <span>插入视频的位置在已有片段内部；先切分或使用覆盖视频。</span> : null}
              {audioInsertBlocked ? <span>插入音频的位置在已有片段内部；先切分或使用覆盖音频。</span> : null}
            </div>
            <div className="timeline-edit-actions">
              <button type="button" className="secondary" disabled={busy || Boolean(sourceRangeError) || videoInsertBlocked} onClick={() => editFromSource("insert")}>插入视频 @ {frameLabel(playhead)}</button><button type="button" disabled={busy || Boolean(sourceRangeError)} onClick={() => editFromSource("overwrite")}>覆盖视频 @ {frameLabel(playhead)}</button><button type="button" className="secondary" disabled={busy || Boolean(sourceRangeError) || !audioTargetTrackId || audioInsertBlocked} onClick={() => editAudioFromSource("insert")}>插入音频 @ {frameLabel(playhead)}</button><button type="button" className="secondary" disabled={busy || Boolean(sourceRangeError) || !audioTargetTrackId} onClick={() => editAudioFromSource("overwrite")}>覆盖音频 @ {frameLabel(playhead)}</button>
            </div>
          </> : <p className="empty-copy">当前剪辑没有可播放素材。先确认本机素材绑定和审阅媒体证据。</p>}
        </div>
      </details>
      <EditorMonitors baseUrl={baseUrl} projectId={projectId} project={snapshot.project} sequence={sequence} selectedClip={selection?.clip ?? null} sourcePreview={sourceOption ? { source: sourceOption.source, frame: sourcePosition, rangeStart: sourceOption.availableIn, rangeEnd: sourceOptionEnd(sourceOption) } : null} playhead={playhead} onPlayheadChange={changePlayhead} onStepFrames={stepPlayhead} onSourceFrameChange={changeSourcePosition} />
    </>
  );
}
