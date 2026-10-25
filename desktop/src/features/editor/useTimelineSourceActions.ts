import type { TimelineCommand } from "../../api/timeline";
import type { ReplacementTakeOption } from "./editorSemantics";
import { buildReplaceTakeCommand, type TimelineSourceOption } from "./timelineSourceEditing";
import { clampSourceCursor } from "./timelineSourceMarks";
import type { TimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import { errorMessage, findClip, localizedEditorialText } from "./timelineWorkbenchSupport";

type Apply = (command: TimelineCommand, success: string) => Promise<void>;

export function useTimelineSourceActions(model: TimelineWorkbenchModel, apply: Apply) {
  const {
    snapshot, sequence, sourceOption, sourceOptions, selection,
    production, projectId, setAssistantStatus, setBusy, setMessage, setSourceId,
    setSourcePosition, setSelectedClipId, changePlayhead,
  } = model;

  function chooseSource(option: TimelineSourceOption): void {
    setSourceId(option.source.source_id);
    setSourcePosition(option.availableIn);
  }
  function changeSourcePosition(frame: number): void {
    if (sourceOption) setSourcePosition(clampSourceCursor(sourceOption, frame));
  }

  function selectTimelineClip(clip: NonNullable<typeof selection>["clip"]): void {
    setSelectedClipId(clip.clip_id); changePlayhead(clip.timeline_start);
    const activeSourceId = clip.selected_angle_source_id ?? clip.source_id;
    const option = sourceOptions.find((item) => item.source.source_id === activeSourceId);
    if (option) { setSourceId(option.source.source_id); setSourcePosition(clip.source_in); }
  }
  function locateClip(clipId: string | undefined): void {
    if (!clipId) return;
    const located = findClip(snapshot, clipId);
    if (located) selectTimelineClip(located.clip);
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
    } catch (error) {
      setMessage(`小镜建议更新失败：${errorMessage(error)}`);
    }
    finally { setBusy(false); }
  }

  return { chooseSource, changeSourcePosition, selectTimelineClip, locateClip, replaceTake, refreshAssistantSuggestions };
}

export type TimelineSourceActions = ReturnType<typeof useTimelineSourceActions>;
