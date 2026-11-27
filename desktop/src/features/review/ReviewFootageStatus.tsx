import type { ReviewTakeGroup } from "../../api/host";
import type { SlateRecord } from "../../api/production";
import { SlateStatusIndicator } from "../../components/StatusIndicators";
import { finalDecision, finalLabels, slateLabels, type AngleSlateFact, type ReviewSlateFacts, type SlateReadState } from "./reviewFootageFacts";
import { reviewSourceClock } from "./reviewLocation";
import "./review-footage-status.css";

export function ReviewFootageStatus({ take, facts, readState = "ready" }: {
  take: ReviewTakeGroup; facts?: ReviewSlateFacts; readState?: SlateReadState;
}) {
  const slate = facts?.take;
  const decision = finalDecision(take);
  const empty = facts?.angles.size ? "场记按机位标记" : readState === "error" ? "场记读取失败" : readState === "loading" ? "场记读取中" : "暂无场记";
  return <span className="review-footage-status" role="group" aria-label="本条素材状态">
    {slate ? <SlateStatusIndicator state={slate.status} label={`场记 ${slateLabels[slate.status]}`} /> :
      <span className="review-slate-empty">{empty}</span>}
    <span className={`review-editorial-status review-final-state state-${decision.state}`} data-state={decision.state} title={decision.actor ? `决定人 · ${decision.actor}` : undefined}>
      剪辑{decision.state === "unreviewed" ? "未决定" : ` · ${finalLabels[decision.state]}`}
    </span>
  </span>;
}

function rangeText(record: SlateRecord): string {
  const range = record.usable_range;
  if (range && Number.isFinite(range.start) && Number.isFinite(range.end) && range.start >= 0 && range.end > range.start) {
    return `场记可用段 ${reviewSourceClock(range.start)}–${reviewSourceClock(range.end)}`;
  }
  return record.status === "partial" ? "可用段未标时码" : "";
}

export function ReviewSlateReference({ record }: { record?: SlateRecord }) {
  if (!record) return null;
  const range = rangeText(record);
  if (!record.note?.trim() && !range) return null;
  return <div className="review-slate-reference" aria-label="本条场记依据">
    {range && <span className="review-slate-range">{range}</span>}
    {record.note?.trim() && <span><b>场记备注</b> {record.note}</span>}
  </div>;
}

export function ReviewAngleStatus({ fact, camera, compact = false }: { fact?: AngleSlateFact; camera: string; compact?: boolean }) {
  if (!fact) return null;
  const status = fact.status ? `场记 ${slateLabels[fact.status]}` : "";
  const range = fact.status ? rangeText(fact.record) : "";
  return <span className="review-angle-status" data-compact={compact || undefined} role="group" aria-label={`${camera}场记参考`}>
    {status && <strong data-state={fact.status}>{status}</strong>}
    {fact.preferred && <strong className="review-angle-preferred">场记首选机位</strong>}
    {range && !compact && <span className="review-slate-range">{range}</span>}
    {fact.note && <span className="review-angle-note" title={fact.note}><b>机位备注</b> {fact.note}</span>}
  </span>;
}
