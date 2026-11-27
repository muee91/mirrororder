import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { HostConnectionError, errorMessage, type ReviewScriptBlock } from "../../api/host";
import { readCurrentOperator, requestCurrentOperator } from "../../components/CurrentOperatorControl";
import {
  EditorialClient,
  type EditorialDecision,
  type EditorialState,
  type EditorialStorePayload,
} from "../../api/planning";
import { ReviewTeamFeedback, collectPayloadTeamFeedback } from "./ReviewTeamFeedback";
import "./review-decision.css";

const STATE_LABELS: Record<string, string> = {
  best: "首选",
  keep: "保留",
  reject: "废弃",
  unreviewed: "未决定",
};

function groupKey(groupId: string): string {
  return `group|${groupId}`;
}

function groupDecision(payload: EditorialStorePayload | null, groupId: string): EditorialDecision | null {
  return payload?.decisions[groupKey(groupId)] ?? null;
}

interface Props {
  baseUrl: string;
  projectId: string;
  groupId: string;
  blocksById?: ReadonlyMap<string, ReviewScriptBlock>;
  onSeekComment?: (clipId: string | undefined, sourceTime: number | undefined) => void;
  compact?: boolean;
  onDecisionChange?: (groupId: string) => void | Promise<void>;
}

interface QueueIssue {
  groupId: string;
  saved: boolean;
  message: string;
  retrying: boolean;
}

export function ReviewDecisionPanel(props: Props) {
  const current = useRef<Props | null>(props);
  const queueRequest = useRef(0);
  const [queueIssue, setQueueIssue] = useState<QueueIssue | null>(null);
  useLayoutEffect(() => {
    current.current = props;
    return () => { current.current = null; };
  }, [props]);

  useLayoutEffect(() => {
    setQueueIssue(null);
    return () => { queueRequest.current += 1; };
  }, [props.baseUrl, props.projectId]);

  async function refreshQueue(groupId: string, saved: boolean): Promise<void> {
    const latest = current.current;
    if (latest?.baseUrl !== props.baseUrl || latest.projectId !== props.projectId || !latest.onDecisionChange) return;
    const request = ++queueRequest.current;
    setQueueIssue(issue => issue ? { ...issue, retrying: true } : null);
    try {
      await latest.onDecisionChange(groupId);
      if (request === queueRequest.current) setQueueIssue(null);
    } catch (error) {
      if (request === queueRequest.current) {
        setQueueIssue({ groupId, saved, message: errorMessage(error), retrying: false });
      }
    }
  }

  const queueTarget = queueIssue?.groupId === props.groupId ? "本条 Take" : "另一条 Take";
  const queueNotice = queueIssue && <div className="review-queue-refresh">
    <span role="alert">{queueIssue.saved ? `${queueTarget} 的选片决定已保存` : `已读取${queueTarget} 的最新决定`}，审阅队列未更新。{queueIssue.message}</span>
    <button type="button" className="secondary" disabled={queueIssue.retrying}
      onClick={() => void refreshQueue(queueIssue.groupId, queueIssue.saved)}>
      {queueIssue.retrying ? "刷新中…" : "刷新队列"}
    </button>
  </div>;

  // A new target must never render or write with the previous target's snapshot,
  // even during the render before its loading effect runs.
  return <ReviewDecisionSession key={JSON.stringify([props.baseUrl, props.projectId, props.groupId])}
    {...props} refreshQueue={refreshQueue} queueNotice={queueNotice} />;
}

function ReviewDecisionSession({ baseUrl, projectId, groupId, blocksById, onSeekComment, compact, refreshQueue, queueNotice }: Props & {
  refreshQueue: (groupId: string, saved: boolean) => Promise<void>;
  queueNotice: ReactNode;
}) {
  const client = useMemo(() => new EditorialClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<EditorialStorePayload | null>(null);
  const [message, setMessage] = useState("读取中…");
  const [busy, setBusy] = useState(false);
  const [loadState, setLoadState] = useState<"loading" | "ready" | "error">("loading");
  const active = useRef(true);
  const requestVersion = useRef(0);
  const writeInFlight = useRef(false);
  const needsQueueRefresh = useRef(false);

  async function reload(afterConflict = false): Promise<void> {
    const version = ++requestVersion.current;
    setPayload(null);
    setLoadState("loading");
    setMessage("读取中…");
    try {
      const next = await client.status(projectId);
      if (!active.current || version !== requestVersion.current) return;
      setPayload(next);
      setLoadState("ready");
      setMessage(afterConflict
        ? "团队状态已更新，原操作未重试。"
        : "");
      if (needsQueueRefresh.current) {
        needsQueueRefresh.current = false;
        void refreshQueue(groupId, false);
      }
    } catch (error) {
      if (!active.current || version !== requestVersion.current) return;
      setLoadState("error");
      setMessage(`${afterConflict ? "最新状态读取失败" : "读取选片状态失败"}：${errorMessage(error)}`);
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

  const feedback = useMemo(
    () => collectPayloadTeamFeedback(payload, groupId, blocksById),
    [payload, groupId, blocksById],
  );
  const decision = groupDecision(payload, groupId);

  async function decide(state: EditorialState): Promise<void> {
    if (!payload || loadState !== "ready" || writeInFlight.current) return;
    const actor = readCurrentOperator();
    if (!actor.trim()) {
      requestCurrentOperator();
      setMessage("请先设置操作者昵称");
      return;
    }
    writeInFlight.current = true;
    const version = ++requestVersion.current;
    setBusy(true);
    setMessage("保存中…");
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
        setMessage("已保存");
      }
      void refreshQueue(groupId, true);
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
        setMessage(`无法确认本次决定是否保存：${errorMessage(error)}`);
      }
    } finally {
      writeInFlight.current = false;
      if (active.current) setBusy(false);
    }
  }

  return (
    <section className={`editorial-decision-section review-decision-panel${compact ? " is-compact" : ""}`} aria-label="当前 Take 最终决定">
      <div className="take-evidence-heading"><strong>选片决定</strong></div>
      <div className="editorial-decision-actions">
        {(["best", "keep", "reject"] as EditorialState[]).map((state) => {
          const selected = decision?.state === state;
          return <button type="button" className={selected ? `is-selected state-${state}` : ""} aria-pressed={selected}
            disabled={busy || !payload} onClick={() => void decide(state)} key={state}>
            <svg className="review-decision-mark" width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor"
              strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" visibility={selected ? "visible" : "hidden"}>
              <path d="m3 8 3 3 7-7" />
            </svg>{STATE_LABELS[state]}
          </button>;
        })}
        {decision ? <button type="button" className="secondary" disabled={busy || !payload} onClick={() => void decide("unreviewed")}>清除</button> : null}
      </div>
      <div className="review-decision-support">
        {message && <div className="review-decision-feedback">
          <span role={loadState === "error" ? "alert" : "status"}>{message}</span>
          {loadState === "error" && <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>重新读取状态</button>}
        </div>}
        {queueNotice}

        <ReviewTeamFeedback feedback={feedback} onSeekComment={onSeekComment} />
        {decision && (
          <p className="editorial-current-decision">
            {decision.actor || "未知决定人"}
            {decision.updated_at ? ` · ${decision.updated_at}` : ""}
          </p>
        )}
      </div>
    </section>
  );
}
