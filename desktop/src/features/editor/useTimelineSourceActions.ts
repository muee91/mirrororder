import { useEffect } from "react";
import type { TimelineCommand } from "../../api/timeline";
import { isEditableKeyboardTarget } from "./editorPlayback";
import type { ReplacementTakeOption } from "./editorSemantics";
import { buildManualSourceCommand, buildReplaceTakeCommand, type ManualSourceEditMode, type TimelineSourceOption } from "./timelineSourceEditing";
import { buildManualAudioCommand, type ManualAudioEditMode } from "./timelineAudioEditing";
import { clampSourceCursor, markSourceIn, markSourceOut } from "./timelineSourceMarks";
import type { TimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import { errorMessage, findClip, frameLabel, localizedEditorialText } from "./timelineWorkbenchSupport";

type Apply = (command: TimelineCommand, success: string) => Promise<void>;

export function useTimelineSourceActions(model: TimelineWorkbenchModel, apply: Apply) {
  const {
    snapshot, sequence, sourceOption, sourceOptions, sourceIn, sourceDuration, sourcePosition,
    sourceRangeError, videoInsertBlocked, audioInsertBlocked, audioTargetTrackId, playhead, selection,
    production, projectId, setAssistantStatus, setBusy, setMessage, setSourceId, setSourceIn,
    setSourceDuration, setSourcePosition, setSelectedClipId, setMoveStart, changePlayhead,
  } = model;

  function chooseSource(option: TimelineSourceOption): void {
    setSourceId(option.source.source_id); setSourceIn(option.availableIn);
    setSourceDuration(option.availableDuration); setSourcePosition(option.availableIn);
  }
  function changeSourcePosition(frame: number): void {
    if (sourceOption) setSourcePosition(clampSourceCursor(sourceOption, frame));
  }
  function setSourceInPrecisely(frame: number): void {
    const next = sourceOption ? clampSourceCursor(sourceOption, frame) : Math.max(0, Math.round(frame));
    setSourceIn(next); setSourcePosition(next);
  }
  function markInAtCursor(): void {
    if (!sourceOption) return;
    try {
      const next = markSourceIn(sourceOption, { sourceIn, duration: sourceDuration }, sourcePosition);
      setSourceIn(next.sourceIn); setSourceDuration(next.duration);
      setMessage(`已设入点 · ${frameLabel(next.sourceIn)} · 出点保持 ${frameLabel(next.sourceIn + next.duration)}`);
    } catch (error) { setMessage(errorMessage(error)); }
  }
  function markOutAtCursor(): void {
    if (!sourceOption) return;
    try {
      const next = markSourceOut(sourceOption, { sourceIn, duration: sourceDuration }, sourcePosition);
      setSourceIn(next.sourceIn); setSourceDuration(next.duration);
      setMessage(`已设出点 · ${frameLabel(next.sourceIn + next.duration)} · 入点保持 ${frameLabel(next.sourceIn)}`);
    } catch (error) { setMessage(errorMessage(error)); }
  }

  useEffect(() => {
    const handle = (event: KeyboardEvent) => {
      if (!sourceOption || isEditableKeyboardTarget(event.target) || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "i" || event.key === "I") { event.preventDefault(); markInAtCursor(); }
      else if (event.key === "o" || event.key === "O") { event.preventDefault(); markOutAtCursor(); }
    };
    globalThis.addEventListener("keydown", handle);
    return () => globalThis.removeEventListener("keydown", handle);
  }, [sourceDuration, sourceIn, sourceOption, sourcePosition]);

  function selectTimelineClip(clip: NonNullable<typeof selection>["clip"]): void {
    setSelectedClipId(clip.clip_id); setMoveStart(clip.timeline_start); changePlayhead(clip.timeline_start);
    const activeSourceId = clip.selected_angle_source_id ?? clip.source_id;
    const option = sourceOptions.find((item) => item.source.source_id === activeSourceId);
    if (option) { setSourceId(option.source.source_id); setSourceIn(clip.source_in); setSourceDuration(clip.duration); setSourcePosition(clip.source_in); }
  }
  function locateClip(clipId: string | undefined): void {
    if (!clipId) return;
    const located = findClip(snapshot, clipId);
    if (located) selectTimelineClip(located.clip);
  }

  function editFromSource(mode: ManualSourceEditMode): void {
    if (!snapshot || !sequence || !sourceOption) { setMessage("需要先选择一个可播放素材。"); return; }
    if (sourceRangeError) { setMessage(sourceRangeError); return; }
    if (mode === "insert" && videoInsertBlocked) { setMessage("插入位置位于现有视频片段内部；请先切分，或改用覆盖视频。"); return; }
    try {
      const command = buildManualSourceCommand(mode, snapshot, sequence, sourceOption, sourceIn, sourceDuration, playhead);
      void apply(command, `${mode === "insert" ? "插入视频" : "覆盖视频"}完成 · ${sourceOption.label} · ${frameLabel(sourceDuration)} @ ${frameLabel(playhead)}`);
    } catch (error) { setMessage(errorMessage(error)); }
  }

  function editAudioFromSource(mode: ManualAudioEditMode): void {
    if (!snapshot || !sequence || !sourceOption) { setMessage("需要先选择一个可播放素材。"); return; }
    if (sourceRangeError) { setMessage(sourceRangeError); return; }
    if (!audioTargetTrackId) { setMessage("当前剪辑没有独立音频轨 A1。"); return; }
    if (mode === "insert" && audioInsertBlocked) { setMessage("插入位置位于现有音频片段内部；请先切分，或改用覆盖音频。"); return; }
    try {
      const command = buildManualAudioCommand(mode, snapshot, sequence, sourceOption, sourceIn, sourceDuration, playhead);
      void apply(command, `${mode === "insert" ? "插入音频" : "覆盖音频"}完成 · ${sourceOption.label} · ${frameLabel(sourceDuration)} @ ${frameLabel(playhead)}`);
    } catch (error) { setMessage(errorMessage(error)); }
  }

  function replaceTake(option: ReplacementTakeOption | null): void {
    if (!option || !sequence || !selection) return;
    if (option.blockedReason) { setMessage(`不能换用该镜次：${option.blockedReason}`); return; }
    const source = sourceOptions.find((item) => item.groupId === option.groupId && item.source.source_id === option.sourceId);
    if (!source) { setMessage("替换镜次的本机素材证据已经变化，请刷新后重试。"); return; }
    try {
      const command = buildReplaceTakeCommand(sequence, selection.clip, source, option.sourceIn);
      void apply(command, `已换镜次 → ${option.label}${option.camera ? ` · ${option.camera} 机` : ""}`);
    } catch (error) { setMessage(localizedEditorialText(errorMessage(error))); }
  }

  async function refreshAssistantSuggestions(): Promise<void> {
    setBusy(true); setMessage("正在让小镜重新检查当前项目证据…");
    try {
      const next = await production.cycleAssistant(projectId, true); setAssistantStatus(next);
      setMessage(next.items?.length ? `小镜建议已更新 · ${next.items.length} 项` : "小镜建议已更新 · 当前没有新增事项");
    } catch (error) { setMessage(`小镜建议更新失败：${errorMessage(error)}`); }
    finally { setBusy(false); }
  }

  return { chooseSource, changeSourcePosition, setSourceInPrecisely, markInAtCursor, markOutAtCursor, selectTimelineClip, locateClip, editFromSource, editAudioFromSource, replaceTake, refreshAssistantSuggestions };
}
