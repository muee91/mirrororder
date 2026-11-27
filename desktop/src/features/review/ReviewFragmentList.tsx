import { useEffect, useRef } from "react";
import { useReviewAspect } from "../media/useReviewAspect";
import type { ReviewAngle, ReviewTakeGroup } from "../../api/host";
import type { SemanticSearchResult } from "../../api/semantic";
import type { MulticamSyncTimeline } from "../../api/syncTimeline";
import { StudioIcon } from "../../components/StudioIcons";
import { cameraPresentation } from "../media/cameraPresentation";
import { mediaCardFromAngle, MirrorOrderMediaCard } from "../media/MirrorOrderMediaCard";
import { takePlaybackBounds } from "../material-script/TakeInspector";
import { evidenceLocation, type EvidenceReference } from "../production/evidenceLocation";
import { reviewMasterOffset } from "./reviewLocation";
import type { ReviewSortOrder } from "./reviewQueueOrder";

export type ReviewHit = { result: SemanticSearchResult; angle?: ReviewAngle; rank: number };
export type ReviewFragment = {
  id: string;
  take: ReviewTakeGroup;
  angle: ReviewAngle;
  reference: EvidenceReference;
  label: string;
  rank: number;
};

export function sameReviewEvidence(left: EvidenceReference | undefined, right: EvidenceReference): boolean {
  return Boolean(left && left.group_id === right.group_id && left.clip_id === right.clip_id && left.media_id === right.media_id
    && left.source === right.source && left.start === right.start && left.end === right.end && left.snippet === right.snippet);
}

export function reviewExcerpt(snippet: string): string {
  const line = snippet.trim().split(/\s+(?=(?:画面|场景|景别|可见人物|动作|道具|标签|画面文字)：)/, 1)[0];
  if (line.length <= 78) return line;
  const sentence = /^.{18,77}?[。！？]/u.exec(line)?.[0];
  return sentence || `${line.slice(0, 77)}…`;
}

export function indexReviewHits(results: SemanticSearchResult[], takes: Map<string, ReviewTakeGroup>) {
  const hits = new Map<string, ReviewHit[]>();
  results.forEach((result, rank) => {
    const take = takes.get(result.group_id);
    if (!take || result.source === "file") return;
    const { clip_id, media_id } = result;
    const angle = clip_id || media_id
      ? take.angles.find((item) => (!clip_id || item.clip_id === clip_id) && (!media_id || item.media_id === media_id))
      : undefined;
    if ((clip_id || media_id) && !angle) return;
    const hit = { result, angle, rank };
    const group = hits.get(take.group_id);
    if (group) group.push(hit);
    else hits.set(take.group_id, [hit]);
  });
  return hits;
}

export function isLocatedReviewHit(result: SemanticSearchResult): boolean {
  return result.metadata.precision !== "take_fallback"
    && (result.source !== "visual" || result.metadata.time_basis === "source")
    && (result.source !== "slate" || result.start !== result.end);
}

function fragmentMasterStart(fragment: ReviewFragment, syncTimeline?: MulticamSyncTimeline): number {
  const { angle, reference, take } = fragment;
  const focus = evidenceLocation("", reference);
  const bounds = takePlaybackBounds(angle, "", take.group_id, focus);
  return angle.timeline_start + reviewMasterOffset(angle, syncTimeline) + bounds.start - bounds.sourceIn;
}

export function reviewFragments(
  takes: ReviewTakeGroup[],
  hitsByGroup: Map<string, ReviewHit[]>,
  matchesFilename: (angle: ReviewAngle) => boolean,
  order: ReviewSortOrder,
  syncTimeline?: MulticamSyncTimeline,
): ReviewFragment[] {
  const chronological = (left: ReviewFragment, right: ReviewFragment) =>
    fragmentMasterStart(left, syncTimeline) - fragmentMasterStart(right, syncTimeline);
  const fragments = takes.flatMap<ReviewFragment>((take) => {
    const hits = hitsByGroup.get(take.group_id) ?? [];
    const filenames = take.angles.filter(matchesFilename);
    if (!filenames.length) {
      const located = hits.flatMap(({ result, rank, angle }) => {
        if (!angle || !isLocatedReviewHit(result)) return [];
        return [{ id: result.document_id, take, angle, reference: result, label: result.source_label, rank }];
      });
      if (located.length) return order === "script" ? located.sort(chronological) : located;
    }
    return (filenames.length ? filenames : take.angles).map((angle) => ({
      id: `${take.group_id}:${angle.clip_id}`,
      take,
      angle,
      label: "原片",
      rank: hits[0]?.rank ?? Number.MAX_SAFE_INTEGER,
      reference: {
        group_id: take.group_id,
        clip_id: angle.clip_id,
        media_id: angle.media_id,
        source: "file",
        metadata: { time_basis: "source" },
        start: angle.playback.source_start ?? angle.source_start,
        end: angle.playback.source_end ?? angle.source_end ?? undefined,
      },
    }));
  });
  if (order === "relevance") return fragments.sort((left, right) => left.rank - right.rank);
  return order === "shooting" ? fragments.sort(chronological) : fragments;
}

export function ReviewAngleFrame({ angle, sourceStart, mediaUrl, onAspectChange, descriptionId }: {
  angle: ReviewAngle; sourceStart?: number; mediaUrl?: string; onAspectChange?: (aspect: number) => void; descriptionId?: string;
}) {
  const model = mediaCardFromAngle(angle);
  const { ratio, measure } = useReviewAspect(angle);
  const notify = useRef(onAspectChange);
  notify.current = onAspectChange;
  useEffect(() => { if (ratio) notify.current?.(ratio); }, [angle, ratio]);
  return <MirrorOrderMediaCard frameAspect={ratio} onFrameAspect={measure} frameDescriptionId={descriptionId} model={{ ...model, sourceStart: sourceStart ?? model.sourceStart,
    playbackUrl: model.playbackUrl ? mediaUrl ?? model.playbackUrl : undefined }} compact frameOnly />;
}

export function ReviewEvidenceHit({ reference, angle, label, active, poster, mediaUrl, onOpen }: {
  reference: EvidenceReference;
  angle?: ReviewAngle;
  label: string;
  active?: boolean;
  poster?: boolean;
  mediaUrl?: string;
  onOpen: (reference: EvidenceReference) => void;
}) {
  const focus = evidenceLocation("", reference);
  const range = focus.sourceRange;
  const time = range && reference.metadata?.precision !== "take_fallback" && (reference.source !== "slate" || range.end !== undefined)
    ? `${range.basis === "take" ? "条内" : "原片"} ${range.start.toFixed(2)}${range.end === undefined ? "" : `–${range.end.toFixed(2)}`}s`
    : "";
  const camera = angle ? cameraPresentation(angle.camera) : null;
  const showFrame = Boolean(angle && poster);
  const description = time && label !== "原片" ? `${label} · ${time}` : time || label || "命中片段";
  const excerpt = reference.snippet ? reviewExcerpt(reference.snippet) : "";
  return (
    <button type="button" className={`review-evidence-hit${showFrame ? " has-frame" : ""}`}
      aria-pressed={active} data-camera-tone={camera?.tone}
      aria-label={showFrame ? [camera?.label, angle?.name, description, excerpt].filter(Boolean).join(" · ") : undefined}
      onClick={(event) => {
      event.stopPropagation();
      onOpen(reference);
    }}>
      {angle && showFrame
        ? <ReviewAngleFrame angle={angle} mediaUrl={mediaUrl} sourceStart={takePlaybackBounds(angle, "", reference.group_id, focus).start} />
        : <StudioIcon name="play" />}
      <span className="review-evidence-copy">
        {angle && <strong>{showFrame ? angle.name : `${camera?.label} · ${angle.name}`}</strong>}
        <small>{description}</small>
        {excerpt && <span>{excerpt}</span>}
      </span>
    </button>
  );
}
