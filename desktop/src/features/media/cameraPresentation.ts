export type CameraTone = "a" | "b" | "c" | "aux" | "custom" | "unknown";
export type StableCameraTone = "a" | "b" | "c" | "aux";

export interface CameraPresentation {
  key: string;
  label: string;
  tone: CameraTone;
  sortOrder: number;
}

export interface StableCameraSlotDefinition {
  tone: StableCameraTone;
  label: string;
  sortOrder: number;
}

export const STABLE_CAMERA_SLOTS: readonly StableCameraSlotDefinition[] = [
  { tone: "a", label: "A机", sortOrder: 10 },
  { tone: "b", label: "B机", sortOrder: 20 },
  { tone: "c", label: "C机", sortOrder: 30 },
  { tone: "aux", label: "AUX", sortOrder: 40 },
];

function normalized(value: string): string {
  return value.trim().replace(/机位/g, "").replace(/机/g, "").replace(/\s+/g, "").toUpperCase();
}

function auxiliaryCamera(key: string): boolean {
  return /^AUX(?:\d+)?$/.test(key)
    || key === "AUXILIARY"
    || key === "辅助"
    || key === "辅助/特殊"
    || key === "辅助特殊"
    || key === "特殊";
}

export function cameraPresentation(value: string): CameraPresentation {
  const raw = value.trim();
  const key = normalized(value);
  if (!key || key === "?" || key === "—" || key === "UNKNOWN") {
    return { key: "", label: "未识别", tone: "unknown", sortOrder: 90 };
  }
  if (/^A(?:\d+)?$/.test(key)) {
    return { key, label: key === "A" ? "A机" : key, tone: "a", sortOrder: 10 };
  }
  if (/^B(?:\d+)?$/.test(key)) {
    return { key, label: key === "B" ? "B机" : key, tone: "b", sortOrder: 20 };
  }
  if (/^C(?:\d+)?$/.test(key)) {
    return { key, label: key === "C" ? "C机" : key, tone: "c", sortOrder: 30 };
  }
  if (auxiliaryCamera(key)) {
    return { key: /^AUX(?:\d+)?$/.test(key) ? key : "AUX", label: /^AUX\d+$/.test(key) ? key : "AUX", tone: "aux", sortOrder: 40 };
  }
  return { key: raw, label: raw, tone: "custom", sortOrder: 60 };
}

export function effectiveCamera(cameraOverride: string | undefined, inferredCamera: string | undefined): CameraPresentation {
  return cameraPresentation(cameraOverride?.trim() || inferredCamera?.trim() || "");
}

export function cameraFilterKey(cameraOverride: string | undefined, inferredCamera: string | undefined): string {
  const presentation = effectiveCamera(cameraOverride, inferredCamera);
  return presentation.key || "__unknown__";
}
