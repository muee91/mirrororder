import { useState } from "react";
import type { ReviewAngle, ReviewTakeGroup } from "../api/host";
import type { EditorialState } from "../api/planning";
import { finalDecision } from "../features/review/reviewFootageFacts";
import { getStableReviewerId, teamApi } from "./teamApi";
import { allTakeOpinions, formatClock, myTakeOpinion, takeCollaborationSummary, takeComments } from "./teamModel";

const LABELS: Record<string, string> = {
  best: "首选",
  keep: "保留",
  reject: "废弃",
  unreviewed: "未判断",
};

interface DrawerProps {
  workspaceId: string;
  projectId: string;
  take: ReviewTakeGroup;
  segmentId?: string | null;
  activeAngle?: ReviewAngle | null;
  currentSourceTime?: number;
  actor: string;
  canWrite: boolean;
  onRequestNickname: () => void;
  onUpdated: () => Promise<void>;
  onSeekTo: (clipId: string | undefined, sourceTime: number | undefined) => void;
}

export function TeamCompactDecisionBar({
  workspaceId,
  projectId,
  take,
  segmentId,
  actor,
  canWrite,
  expanded,
  onToggleExpand,
  onRequestNickname,
  onUpdated,
}: {
  workspaceId: string;
  projectId: string;
  take: ReviewTakeGroup;
  segmentId?: string | null;
  actor: string;
  canWrite: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onRequestNickname: () => void;
  onUpdated: () => Promise<void>;
}) {
  const reviewerId = getStableReviewerId();
  const mine = myTakeOpinion(take, segmentId, reviewerId);
  const myState = (mine?.state as EditorialState) || "unreviewed";
  const collab = takeCollaborationSummary(take);
  const [busy, setBusy] = useState(false);

  async function vote(nextState: EditorialState): Promise<void> {
    if (!canWrite || busy) return;
    if (!actor.trim()) {
      onRequestNickname();
      return;
    }
    const targetState: EditorialState = myState === nextState ? "unreviewed" : nextState;
    setBusy(true);
    try {
      await teamApi.submitOpinion(workspaceId, projectId, {
        targetKind: "group",
        groupId: take.group_id,
        state: targetState,
        actor,
      });
      await onUpdated();
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="tw-compact-bar">
      {canWrite ? (
        <div className="tw-compact-votes" role="group" aria-label="我的表态">
          {(["best", "keep", "reject"] as const).map((value) => (
            <button
              key={value}
              type="button"
              disabled={busy}
              className={`tw-decision-btn is-${value}${myState === value ? " is-selected" : ""}`}
              aria-pressed={myState === value}
              onClick={() => void vote(value)}
            >
              {LABELS[value]}
            </button>
          ))}
        </div>
      ) : (
        <span className="tw-readonly-tag">只读</span>
      )}
      <div className="tw-compact-meta">
        {collab.summaryText ? (
          <span className={`tw-collab-pill${collab.hasConflict ? " is-conflict" : ""}`}>
            {collab.hasConflict ? "有分歧 · " : ""}
            {collab.summaryText}
          </span>
        ) : null}
        <button
          type="button"
          className={`tw-btn-secondary tw-expand-comments${expanded ? " is-active" : ""}`}
          aria-expanded={expanded}
          onClick={onToggleExpand}
        >
          {expanded ? "收起批注" : `批注${collab.commentCount ? ` (${collab.commentCount})` : ""}`}
        </button>
      </div>
    </div>
  );
}

export function TeamOpinionDrawer({
  workspaceId,
  projectId,
  take,
  segmentId,
  activeAngle,
  currentSourceTime,
  actor,
  canWrite,
  onRequestNickname,
  onUpdated,
  onSeekTo,
}: DrawerProps) {
  const reviewerId = getStableReviewerId();
  const mine = myTakeOpinion(take, segmentId, reviewerId);
  const myState = (mine?.state as EditorialState) || "unreviewed";
  const [commentDraft, setCommentDraft] = useState("");
  const [attachTimecode, setAttachTimecode] = useState(true);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");

  const decision = finalDecision(take);
  const opinions = allTakeOpinions(take);
  const comments = takeComments(take);

  async function saveOpinion(nextState: EditorialState): Promise<void> {
    if (!canWrite) return;
    if (!actor.trim()) {
      onRequestNickname();
      return;
    }
    const targetState: EditorialState = myState === nextState && nextState !== "unreviewed" ? "unreviewed" : nextState;
    setBusy(true);
    setFeedback("");
    try {
      await teamApi.submitOpinion(workspaceId, projectId, {
        targetKind: "group",
        groupId: take.group_id,
        state: targetState,
        actor,
        clipId: activeAngle?.clip_id,
        camera: activeAngle?.camera,
        sourceTime: currentSourceTime,
      });
      setFeedback(targetState === "unreviewed" ? "已清除我的表态" : `已表态：${LABELS[targetState]}`);
      await onUpdated();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "保存失败");
    } finally {
      setBusy(false);
    }
  }

  async function submitComment(): Promise<void> {
    const text = commentDraft.trim();
    if (!text || !canWrite) return;
    if (!actor.trim()) {
      onRequestNickname();
      return;
    }
    setBusy(true);
    setFeedback("");
    try {
      await teamApi.addComment(workspaceId, projectId, {
        groupId: take.group_id,
        segmentId: segmentId || undefined,
        clipId: attachTimecode ? activeAngle?.clip_id : undefined,
        camera: attachTimecode ? activeAngle?.camera : undefined,
        sourceTime: attachTimecode ? currentSourceTime : null,
        text,
        actor,
      });
      setCommentDraft("");
      setFeedback("批注已发送");
      await onUpdated();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "发送失败");
    } finally {
      setBusy(false);
    }
  }

  async function removeComment(commentId: string): Promise<void> {
    if (!canWrite || !actor.trim()) return;
    setBusy(true);
    try {
      await teamApi.deleteComment(workspaceId, projectId, {
        groupId: take.group_id,
        commentId,
        actor,
      });
      await onUpdated();
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "删除失败");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="tw-opinion-panel" aria-label="团队审阅意见">
      {decision.state !== "unreviewed" ? (
        <div className="tw-final-banner" data-state={decision.state}>
          <strong>主剪最终决定：{LABELS[decision.state] || decision.state}</strong>
          {decision.actor ? <span>{decision.actor}</span> : null}
        </div>
      ) : null}

      <div className="tw-my-opinion">
        <div className="tw-section-head">
          <strong>我的表态</strong>
          {!canWrite ? <span className="tw-readonly-tag">只读成员</span> : null}
        </div>
        {canWrite ? (
          <div className="tw-decision-grid">
            {(["best", "keep", "reject"] as const).map((value) => (
              <button
                key={value}
                type="button"
                disabled={busy}
                className={`tw-decision-btn is-${value}${myState === value ? " is-selected" : ""}`}
                aria-pressed={myState === value}
                onClick={() => void saveOpinion(value)}
              >
                {LABELS[value]}
              </button>
            ))}
            {myState !== "unreviewed" ? (
              <button
                type="button"
                disabled={busy}
                className="tw-decision-btn is-clear"
                onClick={() => void saveOpinion("unreviewed")}
              >
                清除
              </button>
            ) : null}
          </div>
        ) : (
          <p className="tw-muted-note">当前账号为「查看者」，仅可看片与浏览团队意见。</p>
        )}
        {feedback ? <p className="tw-feedback" role="status">{feedback}</p> : null}
      </div>

      <div className="tw-comments">
        <div className="tw-section-head">
          <strong>审阅批注</strong>
          <span>{comments.length} 条</span>
        </div>
        {canWrite ? (
          <div className="tw-comment-composer">
            <div className="tw-note-row">
              <input
                type="text"
                value={commentDraft}
                maxLength={500}
                placeholder="写一句审阅意见，回车发送…"
                onChange={(event) => setCommentDraft(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    void submitComment();
                  }
                }}
              />
              <button
                type="button"
                className="tw-btn-primary"
                disabled={busy || !commentDraft.trim()}
                onClick={() => void submitComment()}
              >
                发送
              </button>
            </div>
            <div className="tw-timecode-chip-row">
              {attachTimecode && activeAngle ? (
                <span className="tw-time-chip">
                  {activeAngle.camera ? `${activeAngle.camera}机 ` : ""}
                  {formatClock(currentSourceTime)}
                  <button
                    type="button"
                    aria-label="去掉时间点"
                    onClick={() => setAttachTimecode(false)}
                  >
                    ×
                  </button>
                </span>
              ) : (
                <button
                  type="button"
                  className="tw-attach-time-btn"
                  onClick={() => setAttachTimecode(true)}
                >
                  + 附带当前时间点
                </button>
              )}
            </div>
          </div>
        ) : null}
        {comments.length > 0 ? (
          <ul className="tw-comment-list">
            {comments.map((cmt) => {
              const isMine = (cmt.reviewer_id && cmt.reviewer_id === reviewerId) || (!cmt.reviewer_id && cmt.actor === actor);
              return (
                <li key={cmt.comment_id}>
                  <div className="tw-comment-head">
                    <strong>{cmt.actor}</strong>
                    {cmt.source_time !== null && cmt.source_time !== undefined ? (
                      <button
                        type="button"
                        className="tw-time-chip"
                        onClick={() => onSeekTo(cmt.clip_id || undefined, cmt.source_time ?? undefined)}
                      >
                        {cmt.camera ? `${cmt.camera}机 ` : ""}
                        {formatClock(cmt.source_time)}
                      </button>
                    ) : null}
                    {canWrite && isMine ? (
                      <button
                        type="button"
                        className="tw-comment-del"
                        onClick={() => void removeComment(cmt.comment_id)}
                      >
                        删除
                      </button>
                    ) : null}
                  </div>
                  <p>{cmt.text}</p>
                </li>
              );
            })}
          </ul>
        ) : (
          <p className="tw-muted-note">暂无批注</p>
        )}
      </div>

      {opinions.length > 0 ? (
        <div className="tw-team-opinions">
          <div className="tw-section-head">
            <strong>团队表态</strong>
            <span>{opinions.length} 人</span>
          </div>
          <ul className="tw-opinion-list">
            {opinions.map((op, idx) => (
              <li key={`${op.reviewer_id || op.actor}-${idx}`}>
                <div className="tw-opinion-row-top">
                  <strong>{op.actor || "审核人"}</strong>
                  <span className={`tw-state-pill is-${op.state}`}>
                    {LABELS[op.state] || op.state}
                  </span>
                </div>
                {op.note ? <p className="tw-opinion-note">{op.note}</p> : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  );
}
