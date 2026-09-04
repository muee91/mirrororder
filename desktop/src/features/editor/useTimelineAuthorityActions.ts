import { isTauri } from "@tauri-apps/api/core";
import { isTimelineAuthorityConflict, type TimelineCommand, type TimelineSnapshot } from "../../api/timeline";
import { clampPlayhead } from "./editorPlayback";
import type { TimelineWorkbenchModel } from "./useTimelineWorkbenchModel";
import { activeSequence, errorMessage, findClip, frameLabel } from "./timelineWorkbenchSupport";

export function useTimelineAuthorityActions(model: TimelineWorkbenchModel) {
  const {
    timeline, projectId, proposal, snapshot, selectedClipId, sequence, playhead,
    setSnapshot, setSelectedClipId, setPlayhead, setReplaceProposalArmed,
    replaceProposalArmed, setBusy, setMessage, refreshPersistence,
  } = model;

  function adoptEditedSnapshot(next: TimelineSnapshot): void {
    setSnapshot(next);
    setReplaceProposalArmed(false);
    const nextSequence = activeSequence(next);
    const retained = selectedClipId ? findClip(next, selectedClipId)?.clip ?? null : null;
    const firstClip = nextSequence?.tracks.flatMap((track) => track.clips)[0] ?? null;
    const nextSelection = retained ?? firstClip;
    setSelectedClipId(nextSelection?.clip_id ?? "");
    setPlayhead((current) => nextSequence ? clampPlayhead(nextSequence, current) : 0);
  }

  async function recoverAuthorityConflict(error: unknown, action: string): Promise<boolean> {
    if (!isTimelineAuthorityConflict(error)) return false;
    try {
      const current = await timeline.openPersisted(projectId);
      adoptEditedSnapshot(current);
      await refreshPersistence();
      setMessage(`${action}未应用：剪辑版本已变化，已恢复最新本机时间线。请检查后重试；不会自动重放刚才的编辑。`);
    } catch (refreshError) {
      setMessage(`${action}失败，并且自动恢复最新剪辑也失败：${errorMessage(refreshError)}`);
    }
    return true;
  }

  async function confirmProposal(): Promise<void> {
    if (!proposal) { setMessage("需要先确认有效时间基，才能建立初始顺片。"); return; }
    if (!isTauri()) { setMessage("浏览器预览可以检查初始顺片；建立本机剪辑需要在桌面 App 中执行。"); return; }
    if (snapshot && !replaceProposalArmed) {
      setReplaceProposalArmed(true);
      setMessage("当前已有剪辑。重新生成初始顺片会替换当前时间线并清空撤销/重做历史；再次点击确认才会执行。");
      return;
    }
    setBusy(true);
    setMessage(snapshot ? "正在从初始顺片重建本机剪辑…" : "正在建立本机剪辑…");
    try {
      const next = await timeline.loadWithCommands(proposal.baseProject, proposal.commands);
      adoptEditedSnapshot(next);
      await refreshPersistence();
      setMessage(`${snapshot ? "已从初始顺片重建剪辑" : "剪辑已建立并保存"} · ${proposal.commands.length} 段人工确认素材已加入`);
    } catch (error) {
      if (!(await recoverAuthorityConflict(error, "重建剪辑"))) setMessage(errorMessage(error));
    } finally {
      setReplaceProposalArmed(false); setBusy(false);
    }
  }

  async function apply(command: TimelineCommand, success: string): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.apply(command);
      adoptEditedSnapshot(next);
      await refreshPersistence();
      setMessage(success);
    } catch (error) {
      if (!(await recoverAuthorityConflict(error, "编辑"))) setMessage(errorMessage(error));
    } finally { setBusy(false); }
  }

  async function undo(): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.undo(); adoptEditedSnapshot(next); await refreshPersistence();
      setMessage(`已撤销 · 还可撤销 ${next.undo_depth} 步`);
    } catch (error) { if (!(await recoverAuthorityConflict(error, "撤销"))) setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function redo(): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.redo(); adoptEditedSnapshot(next); await refreshPersistence();
      setMessage(`已重做 · 当前可撤销 ${next.undo_depth} 步`);
    } catch (error) { if (!(await recoverAuthorityConflict(error, "重做"))) setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function checkpoint(): Promise<void> {
    setBusy(true);
    try {
      const next = await timeline.checkpoint(); adoptEditedSnapshot(next); await refreshPersistence(); setMessage("当前剪辑已安全保存。");
    } catch (error) { if (!(await recoverAuthorityConflict(error, "保存"))) setMessage(errorMessage(error)); }
    finally { setBusy(false); }
  }

  function splitSelected(): void {
    const selection = model.selection;
    if (!selection || !sequence) return;
    const { clip } = selection;
    if (playhead <= clip.timeline_start || playhead >= clip.timeline_start + clip.duration) {
      setMessage("切分位置必须严格位于当前片段内部。"); return;
    }
    void apply({ type: "split", sequence_id: sequence.sequence_id, clip_id: clip.clip_id, position: playhead, right_clip_id: `${clip.clip_id}:split:${playhead}` }, `已在 ${frameLabel(playhead)} 切分当前片段`);
  }

  return { apply, confirmProposal, undo, redo, checkpoint, splitSelected, adoptEditedSnapshot };
}
