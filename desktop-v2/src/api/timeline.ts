import { invoke, isTauri } from "@tauri-apps/api/core";

export interface FrameRate {
  numerator: number;
  denominator: number;
}

export interface TimelineSource {
  source_id: string;
  clip_id: string;
  media_id: string;
  name: string;
  duration_frames: number | null;
}

export interface TimelineMulticamGroup {
  group_id: string;
  angle_source_ids: string[];
}

export interface TimelineClip {
  clip_id: string;
  source_id: string;
  timeline_start: number;
  source_in: number;
  duration: number;
  enabled: boolean;
  multicam_group_id: string | null;
  selected_angle_source_id: string | null;
  metadata: Record<string, string>;
}

export interface TimelineTrack {
  track_id: string;
  kind: "video" | "audio";
  clips: TimelineClip[];
}

export interface TimelineMarker {
  marker_id: string;
  position: number;
  label: string;
}

export interface TimelineTransition {
  transition_id: string;
  track_id: string;
  left_clip_id: string;
  right_clip_id: string;
  duration: number;
}

export interface TimelineSequence {
  sequence_id: string;
  name: string;
  frame_rate: FrameRate;
  tracks: TimelineTrack[];
  markers: TimelineMarker[];
  transitions: TimelineTransition[];
}

export interface TimelineProject {
  version: number;
  project_id: string;
  sources: TimelineSource[];
  multicam_groups: TimelineMulticamGroup[];
  sequences: TimelineSequence[];
  active_sequence_id: string;
}

export interface TimelineValidationIssue {
  code: string;
  path: string;
  message: string;
}

export interface TimelineSnapshot {
  project: TimelineProject;
  undo_depth: number;
  redo_depth: number;
  validation: TimelineValidationIssue[];
}

export type TimelineCommand =
  | { type: "insert"; sequence_id: string; track_id: string; clip: TimelineClip }
  | { type: "overwrite"; sequence_id: string; track_id: string; clip: TimelineClip }
  | { type: "move"; sequence_id: string; clip_id: string; target_track_id: string; timeline_start: number }
  | { type: "split"; sequence_id: string; clip_id: string; position: number; right_clip_id: string }
  | { type: "trim"; sequence_id: string; clip_id: string; timeline_start: number; source_in: number; duration: number }
  | { type: "ripple_delete"; sequence_id: string; clip_id: string }
  | { type: "disable"; sequence_id: string; clip_id: string; disabled: boolean }
  | { type: "multicam_switch"; sequence_id: string; clip_id: string; source_id: string }
  | { type: "set_marker"; sequence_id: string; marker: TimelineMarker };

interface TimelineBridgeErrorPayload {
  message?: string;
  issues?: TimelineValidationIssue[];
}

export class TimelineBridgeError extends Error {
  readonly issues: TimelineValidationIssue[];

  constructor(message: string, issues: TimelineValidationIssue[] = []) {
    super(message);
    this.name = "TimelineBridgeError";
    this.issues = issues;
  }
}

function requireTimelineRuntime(): void {
  if (!isTauri()) {
    throw new TimelineBridgeError("Timeline Core 只在 Tauri Desktop 运行；浏览器预览保持只读。 ");
  }
}

function bridgeError(error: unknown): TimelineBridgeError {
  if (error instanceof TimelineBridgeError) return error;
  const raw = error as TimelineBridgeErrorPayload | string;
  if (typeof raw === "object" && raw !== null) {
    return new TimelineBridgeError(String(raw.message ?? "Timeline Core 命令失败"), Array.isArray(raw.issues) ? raw.issues : []);
  }
  return new TimelineBridgeError(String(raw));
}

async function callTimeline<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  requireTimelineRuntime();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw bridgeError(error);
  }
}

export class TimelineClient {
  newProject(projectId: string, sequenceId = "main"): Promise<TimelineSnapshot> {
    return callTimeline<TimelineSnapshot>("timeline_new", { projectId, sequenceId });
  }

  load(project: TimelineProject): Promise<TimelineSnapshot> {
    return callTimeline<TimelineSnapshot>("timeline_load", { project });
  }

  snapshot(): Promise<TimelineSnapshot> {
    return callTimeline<TimelineSnapshot>("timeline_snapshot");
  }

  apply(command: TimelineCommand): Promise<TimelineSnapshot> {
    return callTimeline<TimelineSnapshot>("timeline_apply", { command });
  }

  undo(): Promise<TimelineSnapshot> {
    return callTimeline<TimelineSnapshot>("timeline_undo");
  }

  redo(): Promise<TimelineSnapshot> {
    return callTimeline<TimelineSnapshot>("timeline_redo");
  }

  validate(): Promise<TimelineValidationIssue[]> {
    return callTimeline<TimelineValidationIssue[]>("timeline_validate");
  }
}
