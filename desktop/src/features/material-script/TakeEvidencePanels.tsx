import { useEffect, useMemo, useState } from "react";
import type { ReviewAngle, ReviewIssue, ReviewTakeGroup } from "../../api/host";
import {
  EditorialClient,
  type EditorialDecision,
  type EditorialOpinion,
  type EditorialState,
  type EditorialStorePayload,
} from "../../api/planning";
import { HostConnectionError } from "../../api/host";
import "./editorial-inspector.css";

interface AuditJudge {
  verdict?: string;
  confidence?: number;
  reason?: string;
}

interface AuditState {
  available?: boolean;
  stale?: boolean;
  analysis_stale?: boolean;
  mapping_stale?: boolean;
  visual_current?: boolean;
  priority?: number;
  shot_intelligence_available?: boolean;
  judge?: AuditJudge;
  algorithm_feedback?: Record<string, unknown>;
  rough_cut?: Record<string, unknown>;
  role_suggestions?: Array<Record<string, unknown>>;
}

type AuditTake = ReviewTakeGroup & {
  audit_state?: AuditState;
  role_suggestions?: Array<Record<string, unknown>>;
  shot_intelligence?: Record<string, unknown>;
};

type EvidenceAngle = ReviewAngle & {
  technical_issues?: string[];
  visible_people?: string[];
  shot_type?: string;
  coverage_role?: string;
};

type RichIssue = ReviewIssue & { detail?: string; source?: string };

const STATE_LABELS: Record<string, string> = {
  best: "最佳",
  keep: "保留",
  reject: "隐藏",
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

function scalar(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "是" : "否";
  return "";
}

function roleSuggestionLabel(row: Record<string, unknown>): string {
  const role = scalar(row.role_name) || scalar(row.role) || scalar(row.label) || scalar(row.name) || "人物角色建议";
  const confidence = Number(row.confidence ?? row.score ?? 0);
  return confidence > 0 ? `${role} · ${Math.round(confidence * (confidence <= 1 ? 100 : 1))}%` : role;
}

export function AuditEvidencePanel({ take, selectedAngle }: { take: ReviewTakeGroup; selectedAngle: ReviewAngle | null }) {
  const enriched = take as AuditTake;
  const audit = enriched.audit_state;
  const angle = selectedAngle as EvidenceAngle | null;
  const issues = (take.issues ?? []) as RichIssue[];
  const auditIssues = issues.filter((issue) => issue.source === "audit" || !["needs_review", "unresolved", "missing_media", "automation_stale"].includes(issue.code));
  const technicalIssues = angle?.technical_issues ?? [];
  const visiblePeople = angle?.visible_people ?? [];
  const roughCut = audit?.rough_cut ?? {};
  const suggestions = audit?.role_suggestions ?? enriched.role_suggestions ?? [];
  const hasVisualFacts = Boolean(
    angle && ((angle.shot_type && angle.shot_type !== "unknown") || (angle.coverage_role && angle.coverage_role !== "unknown") || technicalIssues.length || visiblePeople.length),
  );
  const hasAudit = Boolean(audit?.available || auditIssues.length || hasVisualFacts);

  if (!hasAudit) return null;

  return (
    <section className="take-evidence-section">
      <div className="take-evidence-heading">
        <div><p className="eyebrow">制作证据</p><strong>Audit / 画面事实</strong></div>
        {typeof audit?.priority === "number" && audit.priority > 0 ? <span>P{audit.priority}</span> : null}
      </div>

      {audit?.analysis_stale ? (
        <p className="evidence-alert is-stale">分析已过期。旧 Audit 判断不再作为当前证据；请重新分析后再参考。</p>
      ) : audit?.mapping_stale ? (
        <p className="evidence-alert is-stale">人工/自动归集已变化。旧 Judge、归集问题和粗剪建议已隐藏；下方只保留仍属于媒体本身的画面事实。</p>
      ) : null}

      {angle ? (
        <div className="evidence-block">
          <span className="evidence-label">当前机位</span>
          <div className="evidence-facts">
            <strong>{angle.camera || "—"}</strong>
            {angle.shot_type && angle.shot_type !== "unknown" ? <span>{angle.shot_type}</span> : <span>景别尚无可靠证据</span>}
            {angle.coverage_role && angle.coverage_role !== "unknown" ? <span>{angle.coverage_role}</span> : null}
          </div>
          {technicalIssues.length ? <div className="evidence-warning-list">{technicalIssues.map((issue) => <span key={issue}>⚠ {issue}</span>)}</div> : null}
          {visiblePeople.length ? <p className="evidence-muted">画面人物线索：{visiblePeople.join(" · ")}</p> : null}
        </div>
      ) : null}

      {!audit?.stale && audit?.judge && (audit.judge.verdict || audit.judge.reason) ? (
        <div className="evidence-block">
          <span className="evidence-label">审计建议 · 非人工决定</span>
          <div className="evidence-judge">
            {audit.judge.verdict ? <strong>{audit.judge.verdict}</strong> : null}
            {typeof audit.judge.confidence === "number" && audit.judge.confidence > 0 ? <span>{Math.round(audit.judge.confidence * 100)}%</span> : null}
          </div>
          {audit.judge.reason ? <p>{audit.judge.reason}</p> : null}
        </div>
      ) : null}

      {!audit?.stale && Object.keys(roughCut).length ? (
        <div className="evidence-block compact-evidence-block">
          <span className="evidence-label">粗剪提示</span>
          <div className="evidence-facts">
            {scalar(roughCut.technical_usability) ? <span>技术 {scalar(roughCut.technical_usability)}</span> : null}
            {scalar(roughCut.take_completeness) ? <span>完整度 {scalar(roughCut.take_completeness)}</span> : null}
            {scalar(roughCut.coverage_role) ? <span>用途 {scalar(roughCut.coverage_role)}</span> : null}
            {scalar(roughCut.continuity_risk) && scalar(roughCut.continuity_risk) !== "unknown" ? <span>连续性 {scalar(roughCut.continuity_risk)}</span> : null}
          </div>
        </div>
      ) : null}

      {!audit?.stale && suggestions.length ? (
        <div className="evidence-block compact-evidence-block">
          <span className="evidence-label">人物角色线索 · 需人工确认</span>
          <div className="evidence-facts">{suggestions.slice(0, 4).map((row, index) => <span key={`${roleSuggestionLabel(row)}-${index}`}>{roleSuggestionLabel(row)}</span>)}</div>
        </div>
      ) : null}

      {!audit?.stale && auditIssues.length ? (
        <div className="evidence-warning-list">
          {auditIssues.slice(0, 6).map((issue, index) => (
            <span key={`${issue.code}-${index}`}>⚠ {issue.label}{issue.detail ? ` · ${issue.detail}` : ""}</span>
          ))}
        </div>
      ) : null}

      <p className="evidence-authority-note">Audit 只提供证据和建议，不会写 Individual Opinion、最终 Editorial Decision 或 FCPXML。</p>
    </section>
  );
}

function groupKey(groupId: string): string {
  return `group|${groupId}`;
}

function assignmentKey(groupId: string, segmentId: string): string {
  return `assignment|${segmentId}|${groupId}`;
}

function opinionRows(payload: EditorialStorePayload | null, groupId: string): EditorialOpinion[] {
  if (!payload) return [];
  const row = payload.opinions[groupKey(groupId)];
  return row ? Object.values(row.reviewers ?? {}) : [];
}

function groupDecision(payload: EditorialStorePayload | null, groupId: string): EditorialDecision | null {
  return payload?.decisions[groupKey(groupId)] ?? null;
}

interface AssignmentEditorialRow {
  segmentId: string;
  opinions: EditorialOpinion[];
  decision: EditorialDecision | null;
}

function assignmentRows(payload: EditorialStorePayload | null, groupId: string): AssignmentEditorialRow[] {
  if (!payload) return [];
  const rows = new Map<string, AssignmentEditorialRow>();
  for (const bucket of Object.values(payload.opinions)) {
    const target = bucket.target;
    if (target?.kind !== "assignment" || target.group_id !== groupId || !target.segment_id) continue;
    rows.set(target.segment_id, {
      segmentId: target.segment_id,
      opinions: Object.values(bucket.reviewers ?? {}),
      decision: payload.decisions[assignmentKey(groupId, target.segment_id)] ?? null,
    });
  }
  for (const decision of Object.values(payload.decisions)) {
    const target = decision.target;
    if (target?.kind !== "assignment" || target.group_id !== groupId || !target.segment_id || rows.has(target.segment_id)) continue;
    rows.set(target.segment_id, { segmentId: target.segment_id, opinions: [], decision });
  }
  return [...rows.values()].sort((left, right) => left.segmentId.localeCompare(right.segmentId));
}

function opinionCounts(opinions: EditorialOpinion[]): Record<string, number> {
  return opinions.reduce<Record<string, number>>((result, opinion) => {
    const state = opinion.state || "unreviewed";
    result[state] = (result[state] ?? 0) + 1;
    return result;
  }, {});
}

export function EditorialDecisionPanel({ baseUrl, projectId, groupId }: { baseUrl: string; projectId: string; groupId: string }) {
  const client = useMemo(() => new EditorialClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<EditorialStorePayload | null>(null);
  const [actor, setActor] = useState(storedActor);
  const [message, setMessage] = useState("正在读取团队意见与最终决定…");
  const [busy, setBusy] = useState(false);

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

  const opinions = opinionRows(payload, groupId);
  const decision = groupDecision(payload, groupId);
  const counts = opinionCounts(opinions);
  const assignments = assignmentRows(payload, groupId);

  async function decide(targetKind: "group" | "assignment", state: EditorialState, segmentId = ""): Promise<void> {
    if (!payload || busy) return;
    if (!actor.trim()) {
      setMessage("最终决定需要操作者昵称。");
      return;
    }
    const scope = targetKind === "assignment" ? `剧本段 ${segmentId}` : "当前 Take";
    setBusy(true);
    saveActor(actor);
    setMessage(state === "unreviewed" ? `正在清除${scope}最终决定…` : `正在写入${scope}最终${STATE_LABELS[state]}…`);
    try {
      const response = await client.decision(projectId, {
        targetKind,
        groupId,
        ...(segmentId ? { segmentId } : {}),
        state,
        actor,
        expectedRevision: payload.revision,
      });
      setPayload(response.editorial);
      setMessage(state === "unreviewed"
        ? `${scope}最终决定已清除 · r${response.editorial.revision}`
        : `${scope}最终：${STATE_LABELS[state]} · r${response.editorial.revision}`);
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
    <section className="editorial-decision-section">
      <div className="take-evidence-heading">
        <div><p className="eyebrow">审阅 authority</p><strong>最终剪辑决定</strong></div>
        <span>{message}</span>
      </div>

      <div className="team-opinion-summary">
        <span className="evidence-label">当前 Take · 团队个人意见</span>
        {opinions.length ? (
          <div className="opinion-counts">
            {Object.entries(counts).filter(([, count]) => count > 0).map(([state, count]) => <span key={state}>{STATE_LABELS[state] || state} {count}</span>)}
          </div>
        ) : <p className="evidence-muted">当前 Take 还没有组级团队个人意见。</p>}
        {opinions.length ? (
          <details className="opinion-details"><summary>查看 {opinions.length} 条个人意见</summary><div>{opinions.map((opinion, index) => <p key={`${opinion.reviewer_id || opinion.actor}-${index}`}><strong>{opinion.actor || "审核人"}</strong><span>{STATE_LABELS[opinion.state] || opinion.state}</span></p>)}</div></details>
        ) : null}
      </div>

      <label className="editorial-actor-field">
        <span>决定人</span>
        <input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="写入最终决定时必填" />
      </label>

      <div className="editorial-decision-actions">
        {(["best", "keep", "reject"] as EditorialState[]).map((state) => (
          <button type="button" className={decision?.state === state ? `is-selected state-${state}` : ""} disabled={busy || !payload} onClick={() => void decide("group", state)} key={state}>{STATE_LABELS[state]}</button>
        ))}
        {decision ? <button type="button" className="secondary" disabled={busy || !payload} onClick={() => void decide("group", "unreviewed")}>清除</button> : null}
      </div>

      {decision ? <p className="editorial-current-decision">当前最终 <strong>{STATE_LABELS[decision.state] || decision.state}</strong> · {decision.actor || "未知决定人"}{decision.updated_at ? ` · ${decision.updated_at}` : ""}</p> : <p className="evidence-muted">当前 Take 尚未形成组级最终剪辑决定。</p>}

      {assignments.length ? (
        <div className="assignment-editorial-section">
          <div className="assignment-editorial-heading">
            <span className="evidence-label">具体剧本段反馈</span>
            <small>{assignments.length} 个剧本段有团队意见或最终决定</small>
          </div>
          <div className="assignment-editorial-list">
            {assignments.map((row) => {
              const rowCounts = opinionCounts(row.opinions);
              return (
                <article className="assignment-editorial-row" key={row.segmentId}>
                  <div className="assignment-editorial-target"><strong>剧本段</strong><code title={row.segmentId}>{row.segmentId}</code></div>
                  {row.opinions.length ? (
                    <>
                      <div className="opinion-counts">
                        {Object.entries(rowCounts).filter(([, count]) => count > 0).map(([state, count]) => <span key={state}>{STATE_LABELS[state] || state} {count}</span>)}
                      </div>
                      <details className="opinion-details"><summary>查看 {row.opinions.length} 条段落意见</summary><div>{row.opinions.map((opinion, index) => <p key={`${opinion.reviewer_id || opinion.actor}-${index}`}><strong>{opinion.actor || "审核人"}</strong><span>{STATE_LABELS[opinion.state] || opinion.state}</span></p>)}</div></details>
                    </>
                  ) : <p className="evidence-muted">该剧本段没有未合并的团队个人意见。</p>}
                  <div className="editorial-decision-actions compact-decision-actions">
                    {(["best", "keep", "reject"] as EditorialState[]).map((state) => (
                      <button type="button" className={row.decision?.state === state ? `is-selected state-${state}` : ""} disabled={busy || !payload} onClick={() => void decide("assignment", state, row.segmentId)} key={state}>{STATE_LABELS[state]}</button>
                    ))}
                    {row.decision ? <button type="button" className="secondary" disabled={busy || !payload} onClick={() => void decide("assignment", "unreviewed", row.segmentId)}>清除</button> : null}
                  </div>
                  {row.decision ? <p className="editorial-current-decision">该段最终 <strong>{STATE_LABELS[row.decision.state] || row.decision.state}</strong> · {row.decision.actor || "未知决定人"}{row.decision.updated_at ? ` · ${row.decision.updated_at}` : ""}</p> : <p className="evidence-muted">该剧本段尚未形成最终决定。</p>}
                </article>
              );
            })}
          </div>
        </div>
      ) : null}

      <p className="evidence-authority-note">这里写的是 Host-local 最终 Editorial Decision；Take 级与剧本段级决定都与 Team Web 的个人意见、场记 NG/可用状态和自动 Audit 分开保存。</p>
    </section>
  );
}
