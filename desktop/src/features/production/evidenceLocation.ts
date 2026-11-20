import type { ProductionSelectionContext } from "./productionNavigation";

export interface EvidenceReference {
  group_id?: string;
  clip_id?: string;
  media_id?: string;
  source?: string;
  start?: number;
  end?: number;
  snippet?: string;
  metadata?: Record<string, unknown>;
}

export function evidenceLocation(projectId: string, reference: EvidenceReference): ProductionSelectionContext {
  const { group_id, clip_id, media_id, source, start, end, metadata } = reference;
  const recordId = typeof metadata?.record_id === "string" ? metadata.record_id : undefined;
  const basis = metadata?.time_basis === "take_relative" || source === "speech"
    ? "take" : metadata?.time_basis === "source" || source === "slate" ? "source" : null;
  const sourceRange: ProductionSelectionContext["sourceRange"] = basis && typeof start === "number" && Number.isFinite(start) && start >= 0
    ? { start, end: typeof end === "number" && Number.isFinite(end) && end > start ? end : undefined, basis }
    : undefined;
  return { projectId, groupId: group_id || undefined, clipId: clip_id || undefined,
    mediaId: media_id || undefined, recordId, sourceRange };
}

export function canOpenEvidence(reference: EvidenceReference): boolean {
  const { groupId, clipId, mediaId, recordId } = evidenceLocation("", reference);
  return Boolean(groupId || clipId || mediaId || recordId);
}
