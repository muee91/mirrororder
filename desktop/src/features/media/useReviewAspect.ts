import { useCallback, useState, type CSSProperties } from "react";
import type { ReviewAngle } from "../../api/host";

// Browser display dimensions include the file's rotation and pixel aspect ratio.
// The read model can predate media probing. Remember geometry for its lifetime.
const knownAspects = new WeakMap<ReviewAngle, number>();

export function useReviewAspect(angle?: ReviewAngle | null) {
  const [measurement, setMeasurement] = useState<{ angle: ReviewAngle; ratio: number }>();
  const ratio = measurement && measurement.angle === angle ? measurement.ratio : angle ? knownAspects.get(angle) : undefined;
  const measure = useCallback((value: number) => {
    if (!angle || !Number.isFinite(value) || value <= 0) return;
    knownAspects.set(angle, value);
    setMeasurement(previous => previous?.angle === angle && previous.ratio === value ? previous : { angle, ratio: value });
  }, [angle]);
  return { ratio, measure };
}

export function reviewAspectStyle(ratio?: number): CSSProperties | undefined {
  return ratio ? { "--review-ratio": ratio } as CSSProperties : undefined;
}
