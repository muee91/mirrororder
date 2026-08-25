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
    <article className="candidate-evidence-card">
      <header>
        <div>
          <span>{candidate.episode_ids.map(episodeLabel).join("/") || "未分集"}</span>
          <strong>{targetIds.join(", ") || "仅集数候选"}</strong>
        </div>
        <div className="candidate-total">
          <small>{candidate.confidence || "candidate"}</small>
          <code>{score(candidate.total_score)}</code>
        </div>
      </header>

      <div className="candidate-score-grid">
        <ScoreRow label="对白" value={candidate.dialogue_score} />
        <ScoreRow label="时序" value={candidate.sequence_score} />
        <ScoreRow label="上下文" value={candidate.context_score} />
      </div>

      <div className="candidate-relation-meta">
        <span>margin <code>{score(candidate.margin)}</code></span>
        <span>method <code>{candidate.method || "—"}</code></span>
        {candidate.relative_start !== undefined && candidate.relative_end !== undefined ? (
          <span>相对范围 <code>{candidate.relative_start.toFixed(2)}–{candidate.relative_end.toFixed(2)}s</code></span>
        ) : null}
      </div>

      {candidate.evidence.length ? (
        <div className="candidate-evidence-chips">
          {candidate.evidence.slice(0, 8).map((item, index) => <span key={`${candidate.candidate_id}-evidence-${index}`}>{item}</span>)}
        </div>
      ) : null}

      {candidate.transcript_text ? <p className="candidate-transcript">{candidate.transcript_text}</p> : null}
      <p className="candidate-authority-note">关系分数仅解释候选来源；必须经过人工归集才会成为 Review authority。</p>
    </article>
  );
}
