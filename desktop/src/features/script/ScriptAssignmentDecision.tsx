import { useEffect, useMemo, useRef, useState } from "react";
import { HostConnectionError, errorMessage } from "../../api/host";
import {
  EditorialClient,
  type EditorialState,
  type EditorialStorePayload,
  type EditorialWriteResponse,
} from "../../api/planning";
import "../review/review-decision.css";

const STATE_LABELS: Record<string, string> = {
  best: "Best",
  keep: "Keep",
  reject: "Reject",
  unreviewed: "未决定",
};

type LoadState = "loading" | "ready" | "error";

interface Props {
  baseUrl: string;
  projectId: string;
  groupId: string;
  segmentId: string;
  actor: string;
  onDecisionChange?: () => void | Promise<unknown>;
}

function assignmentKey(segmentId: string, groupId: string): string {
  return `assignment|${segmentId}|${groupId}`;
}

function assignmentDecision(payload: EditorialStorePayload | null, segmentId: string, groupId: string) {
  if (!payload) return null;
  const decision = payload.decisions[assignmentKey(segmentId, groupId)];
  return decision?.state && decision.state !== "unreviewed" ? decision : null;
}

/**
 * Script owns the segment context, so assignment-level editorial decisions
 * belong here rather than in the Take-level Review panel. The write remains
 * the same revision-safe Host contract and never changes placement or Timeline.
 */
export function ScriptAssignmentDecision({
  baseUrl,
  projectId,
  groupId,
  segmentId,
  actor,
  onDecisionChange,
}: Props) {
  const client = useMemo(() => new EditorialClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<EditorialStorePayload | null>(null);
  const [loadState, setLoadState] = useState<LoadState>("loading");
  const [message, setMessage] = useState("正在读取剧本段最终决定…");
  const [busy, setBusy] = useState(false);
  const active = useRef(true);
  const requestVersion = useRef(0);
  const writeInFlight = useRef(false);

  async function reload(afterConflict = false): Promise<void> {
    const version = ++requestVersion.current;
    setPayload(null);
    setLoadState("loading");
    setMessage(afterConflict ? "状态已变化，正在读取最新剧本段决定…" : "正在读取剧本段最终决定…");
    try {
      const next = await client.status(projectId);
      if (!active.current || version !== requestVersion.current) return;
      setPayload(next);
      setLoadState("ready");
      setMessage(afterConflict ? "已读取最新状态，请重新确认。" : `Editorial r${next.revision}`);
    } catch (error) {
      if (!active.current || version !== requestVersion.current) return;
      setLoadState("error");
      setMessage(`剧本段最终决定读取失败：${errorMessage(error)}。`);
    }
  }

  useEffect(() => {
    active.current = true;
    void reload();
    return () => {
      active.current = false;
      requestVersion.current += 1;
    };
  }, [client, projectId, groupId, segmentId]);

  async function decide(state: EditorialState): Promise<void> {
    if (!payload || loadState !== "ready" || writeInFlight.current) return;
    if (!actor.trim()) {
      setMessage("最终决定需要操作者昵称。");
      return;
    }
    writeInFlight.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    setMessage(state === "unreviewed" ? "正在清除剧本段最终决定…" : `正在写入剧本段最终 ${STATE_LABELS[state]}…`);
    try {
      const response: EditorialWriteResponse = await client.decision(projectId, {
        targetKind: "assignment",
        groupId,
        segmentId,
        state,
        actor,
        expectedRevision: payload.revision,
      });
      if (active.current && version === requestVersion.current) {
        setPayload(response.editorial);
        setLoadState("ready");
        setMessage(state === "unreviewed"
          ? `剧本段最终决定已清除 · r${response.editorial.revision}`
          : `剧本段最终：${STATE_LABELS[state]} · r${response.editorial.revision}`);
      }
      try {
        await onDecisionChange?.();
      } catch {
        // The decision is authoritative even if the surrounding read model refresh fails.
      }
    } catch (error) {
      if (!active.current || version !== requestVersion.current) return;
      if (error instanceof HostConnectionError && error.status === 409) {
        await reload(true);
      } else {
        setPayload(null);
        setLoadState("error");
        setMessage(`无法确认本次剧本段决定是否保存：${errorMessage(error)}。请重新读取状态后再决定。`);
      }
    } finally {
      writeInFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  const decision = assignmentDecision(payload, segmentId, groupId);
  return (
    <section className="editorial-decision-section script-assignment-decision" aria-label="当前剧本段最终决定">
      <div className="take-evidence-heading">
        <div><p className="eyebrow">剧本段 · 最终决定</p><strong>当前 Take 在此剧本段的决定</strong></div>
        <span role={loadState === "error" ? "alert" : "status"}>{message}</span>
      </div>
      {loadState === "error" ? <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>重新读取状态</button> : null}
      <div className="editorial-decision-actions">
        {(["best", "keep", "reject"] as EditorialState[]).map((state) => (
          <button type="button" className={decision?.state === state ? `is-selected state-${state}` : ""} disabled={busy || !payload} onClick={() => void decide(state)} key={state}>{STATE_LABELS[state]}</button>
        ))}
        {decision ? <button type="button" className="secondary" disabled={busy || !payload} onClick={() => void decide("unreviewed")}>清除</button> : null}
      </div>
      {payload ? decision
        ? <p className="editorial-current-decision">当前剧本段最终 <strong>{STATE_LABELS[decision.state] || decision.state}</strong> · {decision.actor || "未知决定人"}{decision.updated_at ? ` · ${decision.updated_at}` : ""}</p>
        : <p className="evidence-muted">当前 Take 尚未形成剧本段最终决定。</p>
        : null}
      <p className="evidence-authority-note">这里只写 assignment 级 Final Editorial Decision，不修改剧本归集、场记事实或 Timeline。</p>
    </section>
  );
}
