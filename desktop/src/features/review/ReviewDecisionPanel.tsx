import { useEffect, useMemo, useState } from "react";
import { HostConnectionError } from "../../api/host";
import {
  EditorialClient,
  type EditorialDecision,
  type EditorialOpinion,
  type EditorialState,
  type EditorialStorePayload,
} from "../../api/planning";
import "./review-decision.css";

const STATE_LABELS: Record<string, string> = {
  best: "Best",
  keep: "Keep",
  reject: "Reject",
  unreviewed: "未决定",
};

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function storedActor(): string {
  try {
    return globalThis.localStorage?.getItem("mirrororder.desktop-v2.review-actor")?.trim()
      || globalThis.localStorage?.getItem("mirrororder.desktop.review-actor")?.trim()
      || "";
  } catch {
    return "";
  }
}

function saveActor(actor: string): void {
  try {
    globalThis.localStorage?.setItem("mirrororder.desktop-v2.review-actor", actor.trim());
  } catch {
    // Device-local convenience only.
  }
}

function groupKey(groupId: string): string {
  return `group|${groupId}`;
}

function groupOpinions(payload: EditorialStorePayload | null, groupId: string): EditorialOpinion[] {
  if (!payload) return [];
  const row = payload.opinions[groupKey(groupId)];
  return row ? Object.values(row.reviewers ?? {}) : [];
}

function groupDecision(payload: EditorialStorePayload | null, groupId: string): EditorialDecision | null {
  return payload?.decisions[groupKey(groupId)] ?? null;
}

function opinionCounts(opinions: EditorialOpinion[]): Record<string, number> {
  return opinions.reduce<Record<string, number>>((result, opinion) => {
    const state = opinion.state || "unreviewed";
    result[state] = (result[state] ?? 0) + 1;
    return result;
  }, {});
}

function assignmentFeedbackCount(payload: EditorialStorePayload | null, groupId: string): number {
  if (!payload) return 0;
  const segments = new Set<string>();
  for (const bucket of Object.values(payload.opinions)) {
    const target = bucket.target;
    if (target?.kind === "assignment" && target.group_id === groupId && target.segment_id) segments.add(target.segment_id);
  }
  for (const decision of Object.values(payload.decisions)) {
    const target = decision.target;
    if (target?.kind === "assignment" && target.group_id === groupId && target.segment_id) segments.add(target.segment_id);
  }
  return segments.size;
}

interface Props {
  baseUrl: string;
  projectId: string;
  groupId: string;
  onDecisionChange?: () => void | Promise<void>;
}

export function ReviewDecisionPanel({ baseUrl, projectId, groupId, onDecisionChange }: Props) {
  const client = useMemo(() => new EditorialClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<EditorialStorePayload | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [message, setMessage] = useState("正在读取团队意见与最终决定…");
  const [busy, setBusy] = useState(false);

  // 顶栏设置操作者后这里要跟上：否则决定按钮保持禁用，
  // 用户只能靠刷新页面才能让"已设置操作者"生效。
  useEffect(() => {
    const sync = () => setActor(storedActor());
    globalThis.addEventListener("mirrororder:operator-change", sync);
    globalThis.addEventListener("storage", sync);
    return () => {
      globalThis.removeEventListener("mirrororder:operator-change", sync);
      globalThis.removeEventListener("storage", sync);
    };
  }, []);

  async function reload(quiet = false): Promise<void> {
    if (!quiet) setMessage("正在读取团队意见与最终决定…");
    try {
      const next = await client.status(projectId);
      setPayload(next);
      if (!quiet) setMessage(`Editorial r${next.revision}`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => { void reload(false); }, [client, projectId, groupId]);

  const opinions = groupOpinions(payload, groupId);
  const decision = groupDecision(payload, groupId);
  const counts = opinionCounts(opinions);
  const assignmentFeedback = assignmentFeedbackCount(payload, groupId);

  async function decide(state: EditorialState): Promise<void> {
    if (!payload || busy) return;
    if (!actor.trim()) {
      setMessage("最终决定需要操作者昵称。");
      return;
    }
    setBusy(true);
    saveActor(actor);
    setMessage(state === "unreviewed" ? "正在清除当前 Take 最终决定…" : `正在写入当前 Take 最终 ${STATE_LABELS[state]}…`);
    try {
      const response = await client.decision(projectId, {
        targetKind: "group",
        groupId,
        state,
        actor,
        expectedRevision: payload.revision,
      });
      setPayload(response.editorial);
      setMessage(state === "unreviewed"
        ? `当前 Take 最终决定已清除 · r${response.editorial.revision}`
        : `当前 Take 最终：${STATE_LABELS[state]} · r${response.editorial.revision}`);
      try {
        await onDecisionChange?.();
      } catch {
        // Decision already succeeded. Parent refresh failure must not rewrite that outcome.
      }
    } catch (error) {
      if (error instanceof HostConnectionError && error.status === 409) {
        await reload(true).catch(() => undefined);
        setMessage("团队状态已变化，已刷新到最新 revision；请根据最新意见重新确认。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="editorial-decision-section review-decision-panel" aria-label="当前 Take 最终决定">
      <div className="take-evidence-heading">
        <div><p className="eyebrow">审阅 · 最终决定</p><strong>Take 最终决定</strong></div>
        <span>{message}</span>
      </div>

      <div className="team-opinion-summary">
        <span className="evidence-label">团队个人意见</span>
        {opinions.length ? (
          <div className="opinion-counts">
            {Object.entries(counts).filter(([, count]) => count > 0).map(([state, count]) => <span key={state}>{STATE_LABELS[state] || state} {count}</span>)}
          </div>
        ) : <p className="evidence-muted">当前 Take 还没有组级团队个人意见。</p>}
        {opinions.length ? (
          <details className="opinion-details">
            <summary>查看 {opinions.length} 条个人意见</summary>
            <div>{opinions.map((opinion, index) => <p key={`${opinion.reviewer_id || opinion.actor}-${index}`}><strong>{opinion.actor || "审核人"}</strong><span>{STATE_LABELS[opinion.state] || opinion.state}</span></p>)}</div>
          </details>
        ) : null}
      </div>

      <label className="editorial-actor-field">
        <span>决定人</span>
        <input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="写入最终决定时必填" />
      </label>

      <div className="editorial-decision-actions">
        {(["best", "keep", "reject"] as EditorialState[]).map((state) => (
          <button type="button" className={decision?.state === state ? `is-selected state-${state}` : ""} disabled={busy || !payload} onClick={() => void decide(state)} key={state}>{STATE_LABELS[state]}</button>
        ))}
        {decision ? <button type="button" className="secondary" disabled={busy || !payload} onClick={() => void decide("unreviewed")}>清除</button> : null}
      </div>

      {decision ? <p className="editorial-current-decision">当前最终 <strong>{STATE_LABELS[decision.state] || decision.state}</strong> · {decision.actor || "未知决定人"}{decision.updated_at ? ` · ${decision.updated_at}` : ""}</p> : <p className="evidence-muted">当前 Take 尚未形成最终决定。</p>}

      {assignmentFeedback ? (
        <p className="review-assignment-feedback-note">另有 {assignmentFeedback} 个剧本段级团队反馈。审阅页不展开剧本段级裁决；需要结合位置上下文时回到“剧本”处理。</p>
      ) : null}

      <p className="evidence-authority-note">这里只写 Take 级 Final Editorial Decision；不会修改剧本 placement、场记事实或 Timeline。</p>
    </section>
  );
}
