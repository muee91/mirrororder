import type { ReviewAngle, ReviewIssue, ReviewTakeGroup } from "../../api/host";
import "./audit-evidence.css";

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
  priority?: number;
  judge?: AuditJudge;
  rough_cut?: Record<string, unknown>;
  role_suggestions?: Array<Record<string, unknown>>;
}

type AuditTake = ReviewTakeGroup & {
  audit_state?: AuditState;
  role_suggestions?: Array<Record<string, unknown>>;
};

type EvidenceAngle = ReviewAngle & {
  technical_issues?: string[];
  visible_people?: string[];
  shot_type?: string;
  coverage_role?: string;
};

type RichIssue = ReviewIssue & { detail?: string; source?: string };

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

      <p className="evidence-authority-note">Audit 只提供证据和建议，不会写 Individual Opinion、Final Editorial Decision 或 Timeline。</p>
    </section>
  );
}
