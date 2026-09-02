export type CameraTone = "a" | "b" | "c" | "custom" | "unknown";

export interface CameraPresentation {
  key: string;
  label: string;
  tone: CameraTone;
  sortOrder: number;
}

function normalized(value: string): string {
  return value.trim().replace(/机位/g, "").replace(/机/g, "").trim().toUpperCase();
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
  return { key: raw, label: raw, tone: "custom", sortOrder: 60 };
}

export function effectiveCamera(cameraOverride: string | undefined, inferredCamera: string | undefined): CameraPresentation {
  return cameraPresentation(cameraOverride?.trim() || inferredCamera?.trim() || "");
}

export function cameraFilterKey(cameraOverride: string | undefined, inferredCamera: string | undefined): string {
  const presentation = effectiveCamera(cameraOverride, inferredCamera);
  return presentation.key || "__unknown__";
}
