import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { HostConnectionError, errorMessage } from "../../api/host";
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

export function ReviewDecisionPanel(props: Props) {
  const current = useRef<Props | null>(props);
  useLayoutEffect(() => {
    current.current = props;
    return () => { current.current = null; };
  }, [props]);

  async function refreshCurrentProject(): Promise<void> {
    const latest = current.current;
    if (latest?.baseUrl !== props.baseUrl || latest.projectId !== props.projectId) return;
    await latest.onDecisionChange?.();
  }

  // A new target must never render or write with the previous target's snapshot,
  // even during the render before its loading effect runs.
  return <ReviewDecisionSession key={JSON.stringify([props.baseUrl, props.projectId, props.groupId])} {...props} onDecisionChange={refreshCurrentProject} />;
}

function ReviewDecisionSession({ baseUrl, projectId, groupId, onDecisionChange }: Props) {
  const client = useMemo(() => new EditorialClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<EditorialStorePayload | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [message, setMessage] = useState("正在读取团队意见与最终决定…");
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const active = useRef(true);
  const requestVersion = useRef(0);
  const writeInFlight = useRef(false);
  const needsQueueRefresh = useRef(false);

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

  async function reload(afterConflict = false): Promise<void> {
    const version = ++requestVersion.current;
    setPayload(null);
    setLoadState("loading");
    setMessage(afterConflict ? "团队状态已变化，正在读取最新意见与决定…" : "正在读取团队意见与最终决定…");
    try {
      const next = await client.status(projectId);
      if (!active.current || version !== requestVersion.current) return;
      setPayload(next);
      setLoadState("ready");
      setMessage(afterConflict
        ? "已读取最新团队状态；请根据最新意见重新确认，原操作未重试。"
        : `Editorial r${next.revision}`);
      if (needsQueueRefresh.current) {
        needsQueueRefresh.current = false;
        try {
          await onDecisionChange?.();
        } catch {
          // The authoritative read succeeded even if the queue refresh failed.
        }
      }
    } catch (error) {
      if (!active.current || version !== requestVersion.current) return;
      setLoadState("error");
      setMessage(`${afterConflict ? "团队状态已变化，但最新状态读取失败" : "团队意见与最终决定读取失败"}：${errorMessage(error)}。重新读取后才能作决定。`);
    }
  }

  useEffect(() => {
    active.current = true;
    void reload();
    return () => {
      active.current = false;
      requestVersion.current += 1;
    };
  }, [client, projectId, groupId]);

  const opinions = groupOpinions(payload, groupId);
  const decision = groupDecision(payload, groupId);
  const counts = opinionCounts(opinions);
  const assignmentFeedback = assignmentFeedbackCount(payload, groupId);

  async function decide(state: EditorialState): Promise<void> {
    if (!payload || loadState !== "ready" || writeInFlight.current) return;
    if (!actor.trim()) {
      setMessage("最终决定需要操作者昵称。");
      return;
    }
    writeInFlight.current = true;
    const version = ++requestVersion.current;
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
      if (active.current && version === requestVersion.current) {
        setPayload(response.editorial);
        setMessage(state === "unreviewed"
          ? `当前 Take 最终决定已清除 · r${response.editorial.revision}`
          : `当前 Take 最终：${STATE_LABELS[state]} · r${response.editorial.revision}`);
      }
      try {
        // Refresh counts after a completed write even if the user moved to the
        // next Take. The outer boundary only permits the originating project.
        await onDecisionChange?.();
      } catch {
        // Decision already succeeded. Parent refresh failure must not rewrite that outcome.
      }
    } catch (error) {
      if (!active.current || version !== requestVersion.current) return;
      needsQueueRefresh.current = true;
      if (error instanceof HostConnectionError && error.status === 409) {
        await reload(true);
      } else {
        // A lost response does not prove the write failed. Require a fresh read
        // instead of allowing a blind replay or presenting stale authority.
        setPayload(null);
        setLoadState("error");
        setMessage(`无法确认本次决定是否保存：${errorMessage(error)}。请重新读取状态后再决定。`);
      }
    } finally {
      writeInFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <section className="editorial-decision-section review-decision-panel" aria-label="当前 Take 最终决定">
      <div className="take-evidence-heading">
        <div><p className="eyebrow">审阅 · 最终决定</p><strong>Take 最终决定</strong></div>
        <span role={loadState === "error" ? "alert" : "status"}>{message}</span>
      </div>

      {loadState === "error" ? <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>重新读取状态</button> : null}

      <div className="team-opinion-summary">
        <span className="evidence-label">团队个人意见</span>
        {!payload ? <p className="evidence-muted">{loadState === "loading" ? "正在读取当前 Take 的团队状态…" : "尚未读取到可信的团队状态。"}</p> : opinions.length ? (
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

      {payload ? decision ? <p className="editorial-current-decision">当前最终 <strong>{STATE_LABELS[decision.state] || decision.state}</strong> · {decision.actor || "未知决定人"}{decision.updated_at ? ` · ${decision.updated_at}` : ""}</p> : <p className="evidence-muted">当前 Take 尚未形成最终决定。</p> : null}

      {assignmentFeedback ? (
        <p className="review-assignment-feedback-note">另有 {assignmentFeedback} 个剧本段级团队反馈。审阅页不展开剧本段级裁决；需要结合位置上下文时回到“剧本”处理。</p>
      ) : null}

      <p className="evidence-authority-note">这里只写 Take 级 Final Editorial Decision；不会修改剧本 placement、场记事实或 Timeline。</p>
    </section>
  );
}
