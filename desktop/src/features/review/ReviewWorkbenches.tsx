import { useEffect, useMemo, useState } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload, type ReviewTakeGroup } from "../../api/host";
import "./review.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenTake?: (groupId: string) => void;
}

type EnrichedTake = ReviewTakeGroup & {
  audit_state?: {
    available?: boolean;
    stale?: boolean;
    analysis_stale?: boolean;
    mapping_stale?: boolean;
    priority?: number;
    judge?: { verdict?: string; confidence?: number; reason?: string };
  };
  editorial_state: ReviewTakeGroup["editorial_state"] & {
    editorial_decision?: {
      group?: { state?: string; actor?: string; updated_at?: string } | null;
      assignments?: Array<Record<string, unknown>>;
    };
  };
};

type EnrichedModel = ReviewModelPayload & {
  summary: ReviewModelPayload["summary"] & {
    audit?: Record<string, unknown>;
    collaboration?: Record<string, unknown>;
    media_roles?: Record<string, unknown>;
  };
  audit_state?: Record<string, unknown>;
};

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function issueLabel(take: ReviewTakeGroup): string[] {
  const audit = (take as EnrichedTake).audit_state;
  const labels = take.issues.map((issue) => issue.label).filter(Boolean);
  if (audit?.analysis_stale) labels.unshift("Audit 分析已过期");
  else if (audit?.mapping_stale) labels.unshift("归集变化，旧 Audit 判断已隐藏");
  if (take.effective_mapping.source === "none") labels.push("尚未形成有效归集");
  return [...new Set(labels)];
}

function priority(take: ReviewTakeGroup): number {
  const audit = (take as EnrichedTake).audit_state;
  if (take.issues.some((issue) => issue.severity === "error")) return 1000;
  if (audit?.mapping_stale || audit?.analysis_stale) return 800 + Number(audit.priority ?? 0);
  if (take.issues.some((issue) => issue.severity === "warning")) return 600 + Number(audit?.priority ?? 0);
  if (take.effective_mapping.source === "none") return 500;
  return Number(audit?.priority ?? 0);
}

function finalState(take: ReviewTakeGroup): string {
  const decision = (take as EnrichedTake).editorial_state?.editorial_decision;
  return String(decision?.group?.state || "unreviewed");
}

function mappingLabel(take: ReviewTakeGroup): string {
  if (take.effective_mapping.source === "human") return "人工归集";
  if (take.effective_mapping.source === "automatic") return "自动归集";
  return "未归集";
}

function useReviewModel(baseUrl: string, projectId: string) {
  const connection = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [model, setModel] = useState<EnrichedModel | null>(null);
  const [message, setMessage] = useState("正在读取审阅状态…");
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    setBusy(true);
    try {
      const next = await connection.reviewModel(projectId) as EnrichedModel;
      setModel(next);
      setMessage(`review.v1 · ${next.take_groups.length} Take · review r${next.revisions.review}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void reload(); }, [connection, projectId]);
  return { model, message, busy, reload };
}

export function ReviewAttentionWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const { model, message, busy, reload } = useReviewModel(baseUrl, projectId);
  const rows = useMemo(() => (model?.take_groups ?? [])
    .filter((take) => issueLabel(take).length > 0)
    .sort((left, right) => priority(right) - priority(left) || left.start - right.start), [model]);

  return (
    <section className="review-production-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">审阅 / Attention</p><h2>待处理</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button></div>
      </header>
      <div className="review-attention-summary"><strong>{rows.length}</strong><span>需要人工注意的 Take</span><p>这里只聚合问题与 stale evidence，不自动修改归集、个人意见或最终剪辑决定。</p></div>
      <div className="review-attention-list">
        {rows.map((take) => {
          const audit = (take as EnrichedTake).audit_state;
          const labels = issueLabel(take);
          return (
            <article className="review-attention-row" key={take.group_id}>
              <div className="review-attention-name"><strong>{take.group_id}</strong><span>{mappingLabel(take)} · {take.cameras.join("/") || "无机位"} · 最终 {finalState(take)}</span></div>
              <div className="review-attention-issues">{labels.slice(0, 4).map((label) => <span key={label}>⚠ {label}</span>)}</div>
              {audit?.judge?.reason && !audit.stale ? <p>{audit.judge.reason}</p> : null}
              {onOpenTake ? <button type="button" onClick={() => onOpenTake(take.group_id)}>打开看片</button> : null}
            </article>
          );
        })}
        {!rows.length ? <p className="empty-copy">当前没有由 review.v1 / Audit 投影出来的待处理项。</p> : null}
      </div>
    </section>
  );
}

export function ProjectOverviewWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const { model, message, busy, reload } = useReviewModel(baseUrl, projectId);
  const mappingCounts = useMemo(() => {
    const result = { human: 0, automatic: 0, none: 0 };
    for (const take of model?.take_groups ?? []) {
      const source = take.effective_mapping.source;
      if (source === "human") result.human += 1;
      else if (source === "automatic") result.automatic += 1;
      else result.none += 1;
    }
    return result;
  }, [model]);
  const decisionCounts = useMemo(() => {
    const result: Record<string, number> = { best: 0, keep: 0, reject: 0, unreviewed: 0 };
    for (const take of model?.take_groups ?? []) result[finalState(take)] = (result[finalState(take)] ?? 0) + 1;
    return result;
  }, [model]);
  const attention = useMemo(() => (model?.take_groups ?? []).filter((take) => issueLabel(take).length).sort((left, right) => priority(right) - priority(left)).slice(0, 8), [model]);
  const auditSummary = model?.summary.audit ?? {};
  const collaboration = model?.summary.collaboration ?? {};

  return (
    <section className="review-production-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">审阅 / Overview</p><h2>概览</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button></div>
      </header>
      {model ? (
        <>
          <div className="review-overview-strip">
            <span><strong>{model.take_groups.length}</strong>Take</span>
            <span><strong>{model.episodes.length}</strong>集</span>
            <span><strong>{model.summary.script_gaps}</strong>剧本缺口</span>
            <span><strong>{mappingCounts.human}</strong>人工归集</span>
            <span><strong>{mappingCounts.none}</strong>未归集</span>
          </div>
          <div className="review-overview-grid">
            <section className="review-overview-pane">
              <p className="eyebrow">最终剪辑决定</p>
              <div className="review-state-bars"><span>最佳 <strong>{decisionCounts.best}</strong></span><span>保留 <strong>{decisionCounts.keep}</strong></span><span>隐藏 <strong>{decisionCounts.reject}</strong></span><span>未决定 <strong>{decisionCounts.unreviewed}</strong></span></div>
              <p className="production-note">这里只汇总 Final Editorial Decision；Team Web 的个人意见不被当成最终决定。</p>
            </section>
            <section className="review-overview-pane">
              <p className="eyebrow">协作 / Audit</p>
              <dl className="review-fact-list"><div><dt>个人意见</dt><dd>{String(collaboration.opinions ?? 0)}</dd></div><div><dt>审核人</dt><dd>{String(collaboration.reviewers ?? 0)}</dd></div><div><dt>最终决定</dt><dd>{String(collaboration.decisions ?? 0)}</dd></div><div><dt>Audit current</dt><dd>{String(auditSummary.current_groups ?? 0)}</dd></div><div><dt>mapping stale</dt><dd>{String(auditSummary.mapping_stale_groups ?? 0)}</dd></div></dl>
            </section>
          </div>
          <section className="review-overview-pane review-overview-attention">
            <div className="review-pane-heading"><div><p className="eyebrow">下一步</p><h3>优先看片</h3></div><span>{attention.length} / {model.take_groups.filter((take) => issueLabel(take).length).length}</span></div>
            <div className="review-overview-takes">{attention.map((take) => <button type="button" key={take.group_id} onClick={() => onOpenTake?.(take.group_id)}><strong>{take.group_id}</strong><span>{issueLabel(take)[0] || mappingLabel(take)}</span></button>)}</div>
          </section>
        </>
      ) : <p className="empty-copy">{message}</p>}
    </section>
  );
}
