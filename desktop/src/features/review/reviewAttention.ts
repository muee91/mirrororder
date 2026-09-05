import type { ReviewModelPayload, ReviewTakeGroup } from "../../api/host";

export interface CollaborationTarget {
  kind?: string;
  group_id?: string;
  segment_id?: string;
}

export interface CollaborationOpinion {
  target?: CollaborationTarget;
  state?: string;
  actor?: string;
  reviewer_id?: string;
  updated_at?: string;
}

export interface CollaborationDecision {
  target?: CollaborationTarget;
  state?: string;
  actor?: string;
  updated_at?: string;
}

export interface CollaborationEditorialState {
  individual_opinions?: {
    group?: CollaborationOpinion[];
    assignments?: CollaborationOpinion[];
  };
  editorial_decision?: {
    group?: CollaborationDecision | null;
    assignments?: CollaborationDecision[];
  };
}

export interface CollaborationAttention {
  labels: string[];
  priority: number;
  opinionCount: number;
  reviewerCount: number;
  pendingTargets: number;
  newerTargets: number;
  conflictingTargets: number;
  hasAttention: boolean;
  summary: string;
}

export interface ReviewTakeAttentionProjection {
  labels: string[];
  priority: number;
  context: string;
  hasAttention: boolean;
}

export interface ReviewProjectSummary {
  takeCount: number;
  episodeCount: number;
  scriptGapCount: number;
  attentionCount: number;
  humanMappingCount: number;
  automaticMappingCount: number;
  unmappedCount: number;
  bestCount: number;
  keepCount: number;
  rejectCount: number;
  unreviewedCount: number;
  teamAttentionCount: number;
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
  editorial_state: ReviewTakeGroup["editorial_state"] & CollaborationEditorialState;
};

function timestamp(value: string | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function assignmentKey(segmentId: string | undefined): string {
  return `assignment|${String(segmentId || "")}`;
}

function reviewerKey(opinion: CollaborationOpinion): string {
  const reviewerId = String(opinion.reviewer_id || "").trim();
  if (reviewerId) return `id:${reviewerId}`;
  const actor = String(opinion.actor || "").trim();
  return actor ? `actor:${actor}` : "anonymous";
}

function latestOpinionTime(opinions: CollaborationOpinion[]): number | null {
  let latest: number | null = null;
  for (const opinion of opinions) {
    const value = timestamp(opinion.updated_at);
    if (value !== null && (latest === null || value > latest)) latest = value;
  }
  return latest;
}

function hasConflict(opinions: CollaborationOpinion[]): boolean {
  const states = new Set(
    opinions
      .map((opinion) => String(opinion.state || ""))
      .filter((state) => state && state !== "unreviewed"),
  );
  return states.size > 1;
}

export function collaborationAttention(
  editorialState: CollaborationEditorialState | null | undefined,
): CollaborationAttention {
  const opinions = editorialState?.individual_opinions;
  const decisions = editorialState?.editorial_decision;
  const targets = new Map<string, CollaborationOpinion[]>();

  const groupOpinions = Array.isArray(opinions?.group) ? opinions.group : [];
  if (groupOpinions.length) targets.set("group", groupOpinions);

  for (const opinion of Array.isArray(opinions?.assignments) ? opinions.assignments : []) {
    const key = assignmentKey(opinion.target?.segment_id);
    const rows = targets.get(key) ?? [];
    rows.push(opinion);
    targets.set(key, rows);
  }

  const assignmentDecisions = new Map<string, CollaborationDecision>();
  for (const decision of Array.isArray(decisions?.assignments) ? decisions.assignments : []) {
    assignmentDecisions.set(assignmentKey(decision.target?.segment_id), decision);
  }

  let pendingTargets = 0;
  let newerTargets = 0;
  let conflictingTargets = 0;
  let opinionCount = 0;
  const reviewers = new Set<string>();

  for (const [key, rows] of targets) {
    opinionCount += rows.length;
    rows.forEach((row) => reviewers.add(reviewerKey(row)));
    const decision = key === "group" ? decisions?.group ?? null : assignmentDecisions.get(key) ?? null;
    const conflict = hasConflict(rows);
    const latestOpinion = latestOpinionTime(rows);
    const decisionTime = timestamp(decision?.updated_at);
    const newerThanDecision = Boolean(
      decision
        && latestOpinion !== null
        && decisionTime !== null
        && latestOpinion > decisionTime,
    );
    const needsAttention = !decision || newerThanDecision;
    if (!needsAttention) continue;
    if (!decision) pendingTargets += 1;
    else newerTargets += 1;
    if (conflict) conflictingTargets += 1;
  }

  const labels: string[] = [];
  if (pendingTargets) labels.push(`团队意见待裁决（${pendingTargets}项）`);
  if (newerTargets) labels.push(`最终决定后收到新意见（${newerTargets}项）`);
  if (conflictingTargets) labels.push(`团队意见有分歧（${conflictingTargets}项）`);

  const hasAttention = pendingTargets + newerTargets > 0;
  let priority = 0;
  if (pendingTargets) priority = 900;
  if (newerTargets) priority = 950;
  if (conflictingTargets) priority = Math.min(980, priority + 20);

  const summary = opinionCount
    ? `团队 ${opinionCount} 条意见 · ${reviewers.size} 人`
    : "暂无团队意见";

  return {
    labels,
    priority,
    opinionCount,
    reviewerCount: reviewers.size,
    pendingTargets,
    newerTargets,
    conflictingTargets,
    hasAttention,
    summary,
  };
}

export function reviewTakeAttention(take: ReviewTakeGroup): ReviewTakeAttentionProjection {
  const enriched = take as EnrichedTake;
  const audit = enriched.audit_state;
  const collaboration = collaborationAttention(enriched.editorial_state);
  const labels = take.issues.map((issue) => issue.label).filter(Boolean);

  if (audit?.analysis_stale) labels.unshift("分析证据已过期");
  else if (audit?.mapping_stale) labels.unshift("归集变化，旧分析判断已隐藏");
  labels.push(...collaboration.labels);
  if (take.effective_mapping.source === "none") labels.push("尚未形成有效归集");

  let priority = Number(audit?.priority ?? 0);
  if (take.issues.some((issue) => issue.severity === "error")) priority = Math.max(priority, 1000);
  else if (audit?.mapping_stale || audit?.analysis_stale) priority = Math.max(priority, 800 + Number(audit.priority ?? 0));
  else if (take.issues.some((issue) => issue.severity === "warning")) priority = Math.max(priority, 600 + Number(audit?.priority ?? 0));
  else if (take.effective_mapping.source === "none") priority = Math.max(priority, 500);
  priority = Math.max(priority, collaboration.priority);

  const context = audit?.judge?.reason && !audit.stale
    ? audit.judge.reason
    : collaboration.hasAttention
      ? collaboration.summary
      : "";
  const uniqueLabels = [...new Set(labels)];

  return {
    labels: uniqueLabels,
    priority,
    context,
    hasAttention: uniqueLabels.length > 0,
  };
}

function finalEditorialState(take: ReviewTakeGroup): string {
  const enriched = take as EnrichedTake;
  return String(enriched.editorial_state?.editorial_decision?.group?.state || "unreviewed");
}

export function reviewProjectSummary(model: ReviewModelPayload): ReviewProjectSummary {
  const result: ReviewProjectSummary = {
    takeCount: model.take_groups.length,
    episodeCount: model.episodes.length,
    scriptGapCount: Number(model.summary.script_gaps || 0),
    attentionCount: 0,
    humanMappingCount: 0,
    automaticMappingCount: 0,
    unmappedCount: 0,
    bestCount: 0,
    keepCount: 0,
    rejectCount: 0,
    unreviewedCount: 0,
    teamAttentionCount: 0,
  };

  for (const take of model.take_groups) {
    const source = take.effective_mapping.source;
    if (source === "human") result.humanMappingCount += 1;
    else if (source === "automatic") result.automaticMappingCount += 1;
    else result.unmappedCount += 1;

    const state = finalEditorialState(take);
    if (state === "best") result.bestCount += 1;
    else if (state === "keep") result.keepCount += 1;
    else if (state === "reject") result.rejectCount += 1;
    else result.unreviewedCount += 1;

    const attention = reviewTakeAttention(take);
    if (attention.hasAttention) result.attentionCount += 1;
    if (collaborationAttention((take as EnrichedTake).editorial_state).hasAttention) result.teamAttentionCount += 1;
  }

  return result;
}
