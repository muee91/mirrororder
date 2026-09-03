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
