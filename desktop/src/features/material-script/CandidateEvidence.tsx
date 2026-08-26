import type { ReviewCandidate } from "../../api/host";
import "./candidate-evidence.css";
import { episodeLabel } from "./VirtualTakeList";

function score(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return value.toFixed(3);
}

function percent(value: number): string {
  if (!Number.isFinite(value)) return "0%";
  return `${Math.max(0, Math.min(100, value * 100)).toFixed(0)}%`;
}

function ScoreRow({ label, value }: { label: string; value: number }) {
  return (
    <div className="candidate-score-row">
      <span>{label}</span>
      <div className="candidate-score-track" aria-label={`${label} ${score(value)}`}>
        <i style={{ width: percent(value) }} />
      </div>
      <code>{score(value)}</code>
    </div>
  );
}

export function CandidateEvidence({ candidate }: { candidate: ReviewCandidate }) {
  const targetIds = candidate.script_segment_ids.length > 0
    ? candidate.script_segment_ids
    : candidate.script_segment_id
      ? [candidate.script_segment_id]
      : [];

  return (
    <article className="candidate-evidence-card fixed-confidence-card">
      <header className="candidate-card-header">
        <div className="candidate-target">
          <span>{candidate.episode_ids.map(episodeLabel).join("/") || "未分集"}</span>
          <strong title={targetIds.join(", ")}>{targetIds.join(", ") || "仅集数候选"}</strong>
        </div>
        <div className="candidate-total" aria-label={`总分 ${score(candidate.total_score)}`}>
          <small>置信度</small>
          <strong>{candidate.confidence || "候选"}</strong>
          <code>{score(candidate.total_score)}</code>
        </div>
      </header>

      <div className="candidate-score-grid" aria-label="候选关系评分">
        <ScoreRow label="对白" value={candidate.dialogue_score} />
        <ScoreRow label="时序" value={candidate.sequence_score} />
        <ScoreRow label="上下文" value={candidate.context_score} />
      </div>

      <div className="candidate-relation-meta">
        <span>差距 <code>{score(candidate.margin)}</code></span>
        <span>方法 <code title={candidate.method || "—"}>{candidate.method || "—"}</code></span>
        {candidate.relative_start !== undefined && candidate.relative_end !== undefined ? (
          <span>范围 <code>{candidate.relative_start.toFixed(2)}–{candidate.relative_end.toFixed(2)}s</code></span>
        ) : <span>范围 <code>—</code></span>}
      </div>

      <div className="candidate-card-evidence-slot">
        {candidate.evidence.length ? (
          <div className="candidate-evidence-chips">
            {candidate.evidence.slice(0, 4).map((item, index) => <span title={item} key={`${candidate.candidate_id}-evidence-${index}`}>{item}</span>)}
          </div>
        ) : <span className="candidate-empty-evidence">无额外证据标签</span>}
      </div>

      <p className={`candidate-transcript ${candidate.transcript_text ? "" : "is-empty"}`} title={candidate.transcript_text || ""}>
        {candidate.transcript_text || "无候选对白片段"}
      </p>
      <p className="candidate-authority-note">关系分数只解释候选来源；人工归集后才进入 Review authority。</p>
    </article>
  );
}
