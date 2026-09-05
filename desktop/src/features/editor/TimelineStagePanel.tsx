import { takeDisplayLabel } from "../material-script/TakeCard";
import { frameLabel } from "./timelineWorkbenchSupport";

function clipDisplayLabel(clip: any, review: any): string {
  const groupId = String(clip.metadata?.group_id || "");
  if (groupId && review?.take_groups) {
    const take = review.take_groups.find((item: any) => item.group_id === groupId);
    if (take) return takeDisplayLabel(take);
  }
  return String(clip.metadata?.segment_label || clip.metadata?.scene || clip.metadata?.camera || "片段");
}

export function TimelineStagePanel(props: { [key: string]: any }) {
  const { snapshot, sequence, busy, undo, redo, checkpoint, playhead, changePlayhead, apply, persistence, maxEnd, selectedClipId, selectTimelineClip, review } = props;
  return (
    <>
      <div className="timeline-toolbar production-panel editorial-toolbar">
        <div className="timeline-history"><button type="button" className="secondary" disabled={busy || snapshot.undo_depth === 0} onClick={() => void undo()}>撤销 {snapshot.undo_depth}</button><button type="button" className="secondary" disabled={busy || snapshot.redo_depth === 0} onClick={() => void redo()}>重做 {snapshot.redo_depth}</button><button type="button" className="secondary" disabled={busy} onClick={() => void checkpoint()}>保存</button></div>
        <label>播放头 <input type="number" min={0} value={playhead} onChange={(event) => changePlayhead(Number(event.target.value) || 0)} /></label>
        <button type="button" className="secondary" disabled={busy} onClick={() => void apply({ type: "set_marker", sequence_id: sequence.sequence_id, marker: { marker_id: `marker:${playhead}`, position: playhead, label: `标记 ${playhead}`, kind: "editorial" } }, `已设置标记 @ ${frameLabel(playhead)}`)}>添加标记</button>
        <span>{sequence.frame_rate.numerator}/{sequence.frame_rate.denominator} fps · {snapshot.validation.length ? `${snapshot.validation.length} 个结构问题` : "结构检查通过"}{persistence?.used_backup ? " · 已从备份恢复" : persistence?.recovered_operations ? ` · 已恢复 ${persistence.recovered_operations} 步编辑` : ""}</span>
      </div>
      <div className="timeline-stage production-panel">
        {sequence.tracks.map((track: any) => <div className="timeline-track" key={track.track_id}><div className="track-label"><strong>{track.track_id}</strong><span>{track.kind === "video" ? "视频" : "音频"}</span></div><div className="track-lane">{track.clips.map((clip: any) => <button type="button" className={`timeline-clip ${clip.clip_id === selectedClipId ? "is-selected" : ""} ${clip.enabled ? "" : "is-disabled"}`} key={clip.clip_id} style={{ left: `${(clip.timeline_start / maxEnd) * 100}%`, width: `${Math.max(1.5, (clip.duration / maxEnd) * 100)}%` }} onClick={() => selectTimelineClip(clip)} title={`${clipDisplayLabel(clip, review)}\n${clip.timeline_start}–${clip.timeline_start + clip.duration}f`}><strong>{clipDisplayLabel(clip, review)}</strong><span>{frameLabel(clip.duration)}</span></button>)}</div></div>)}
        {sequence.markers.length ? <div className="timeline-marker-list">{sequence.markers.map((marker: any) => <span key={marker.marker_id}>{frameLabel(marker.position)} · {marker.label}</span>)}</div> : null}
      </div>
    </>
  );
}
