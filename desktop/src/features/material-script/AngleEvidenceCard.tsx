import type { ReviewAngle } from "../../api/host";
import { MirrorOrderMediaCard, mediaCardFromAngle } from "../media/MirrorOrderMediaCard";

export interface AngleEvidenceCardProps {
  angle: ReviewAngle;
  selected?: boolean;
  onSelect?: (clipId: string) => void;
  compact?: boolean;
}

/**
 * Compatibility adapter for Review surfaces.
 *
 * ReviewAngle remains the evidence model, while MirrorOrderMediaCard owns the
 * visual contract. This component intentionally contains no independent media
 * status/shot/camera rendering logic so Take list, Inspector and Slate cannot
 * drift into separate card systems again.
 */
export function AngleEvidenceCard({ angle, selected = false, onSelect, compact = false }: AngleEvidenceCardProps) {
  return (
    <MirrorOrderMediaCard
      model={mediaCardFromAngle(angle)}
      selected={selected}
      compact={compact}
      onSelect={onSelect}
    />
  );
}
