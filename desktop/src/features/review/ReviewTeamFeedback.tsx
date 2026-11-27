import type { ReviewScriptBlock, ReviewTakeGroup } from "../../api/host";
import type { EditorialComment, EditorialOpinion, EditorialStorePayload } from "../../api/planning";
import { reviewSourceClock } from "./reviewLocation";
import "./review-team-feedback.css";

const STATE_LABELS: Record<string, string> = {
  best: "首选",
  keep: "保留",
  reject: "废弃",
  unreviewed: "未决定",
};

export interface TeamOpinionItem extends EditorialOpinion {
  segmentId?: string;
  segmentText?: string;
}

export interface TeamFeedbackSummary {
  opinions: TeamOpinionItem[];
  comments: EditorialComment[];
  counts: Record<string, number>;
  hasConflict: boolean;
}

export function collectTakeTeamFeedback(
  take: ReviewTakeGroup,
  blocksById?: ReadonlyMap<string, ReviewScriptBlock>,
): TeamFeedbackSummary {
  const editorial = take.editorial_state as
    | {
        individual_opinions?: {
          group?: Array<EditorialOpinion & { target?: { segment_id?: string } }>;
          assignments?: Array<EditorialOpinion & { target?: { segment_id?: string } }>;
        };
        comments?: EditorialComment[];
      }
    | undefined;
  const opinions: TeamOpinionItem[] = [];
  for (const row of editorial?.individual_opinions?.group ?? []) {
    opinions.push({ ...row });
  }
  for (const row of editorial?.individual_opinions?.assignments ?? []) {
    const segId = row.target?.segment_id || "";
    const blk = segId ? blocksById?.get(segId) : undefined;
    opinions.push({
      ...row,
      segmentId: segId,
      segmentText: blk?.text || blk?.raw_text || "",
    });
  }
  const comments = Array.isArray(editorial?.comments) ? editorial.comments : [];
  return summarizeFeedback(opinions, comments);
}

export function collectPayloadTeamFeedback(
  payload: EditorialStorePayload | null,
  groupId: string,
  blocksById?: ReadonlyMap<string, ReviewScriptBlock>,
): TeamFeedbackSummary {
  if (!payload) return { opinions: [], comments: [], counts: {}, hasConflict: false };
  const opinions: TeamOpinionItem[] = [];
  for (const bucket of Object.values(payload.opinions ?? {})) {
    if (bucket.target?.group_id !== groupId) continue;
    const segId = bucket.target.kind === "assignment" ? bucket.target.segment_id || "" : "";
    const blk = segId ? blocksById?.get(segId) : undefined;
    for (const row of Object.values(bucket.reviewers ?? {})) {
      opinions.push({
        ...row,
        segmentId: segId || undefined,
        segmentText: blk?.text || blk?.raw_text || undefined,
      });
    }
  }
  const comments = payload.comments?.[`group|${groupId}`] ?? [];
  return summarizeFeedback(opinions, comments);
}

function summarizeFeedback(opinions: TeamOpinionItem[], comments: EditorialComment[]): TeamFeedbackSummary {
  const counts: Record<string, number> = {};
  const distinctStates = new Set<string>();
  for (const op of opinions) {
    const state = op.state || "unreviewed";
    counts[state] = (counts[state] ?? 0) + 1;
    if (state !== "unreviewed") distinctStates.add(state);
  }
  return {
    opinions,
    comments,
    counts,
    hasConflict: distinctStates.size > 1,
  };
}

interface Props {
  feedback: TeamFeedbackSummary;
  onSeekComment?: (clipId: string | undefined, sourceTime: number | undefined) => void;
  defaultOpen?: boolean;
}

export function ReviewTeamFeedback({ feedback, onSeekComment, defaultOpen }: Props) {
  if (!feedback.opinions.length && !feedback.comments.length) return null;

  return (
    <details className="review-team-feedback" open={defaultOpen}>
      <summary>
        <span>
          团队意见
          {feedback.opinions.length ? ` ${feedback.opinions.length} 条` : ""}
          {feedback.comments.length ? ` · 批注 ${feedback.comments.length}` : ""}
        </span>
        {feedback.hasConflict ? <em className="review-team-conflict">有分歧</em> : null}
      </summary>
      <div className="review-team-feedback-body">
        {Object.keys(feedback.counts).length > 0 ? (
          <div className="review-team-counts">
            {Object.entries(feedback.counts).map(([state, count]) => (
              <span key={state}>
                {STATE_LABELS[state] || state} {count}
              </span>
            ))}
          </div>
        ) : null}

        {feedback.opinions.map((op, index) => (
          <div className="review-team-row" key={`${op.reviewer_id || op.actor}-${op.segmentId || "g"}-${index}`}>
            <div className="review-team-row-head">
              <strong>{op.actor || "审核人"}</strong>
              <span>{STATE_LABELS[op.state] || op.state}</span>
            </div>
            {op.segmentText ? <small className="review-team-segment">台词：{op.segmentText.slice(0, 36)}</small> : null}
            {op.note ? <p className="review-team-note">{op.note}</p> : null}
          </div>
        ))}

        {feedback.comments.map((cmt) => (
          <div className="review-team-row is-comment" key={cmt.comment_id}>
            <div className="review-team-row-head">
              <strong>{cmt.actor}</strong>
              {cmt.source_time !== null && cmt.source_time !== undefined ? (
                <button
                  type="button"
                  className="review-team-timecode"
                  onClick={() => onSeekComment?.(cmt.clip_id || undefined, cmt.source_time ?? undefined)}
                >
                  {cmt.camera ? `${cmt.camera}机 ` : ""}
                  {reviewSourceClock(cmt.source_time)}
                </button>
              ) : null}
            </div>
            <p className="review-team-note">{cmt.text}</p>
          </div>
        ))}
      </div>
    </details>
  );
}
