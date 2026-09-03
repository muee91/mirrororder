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

export interface TimelineMulticamAngle {
  source_id: string;
  camera: string;
  name: string;
  sync_start_frame: number | null;
  sync_end_frame: number | null;
}

export interface TimelineMulticamGroup {
  group_id: string;
  /** v1 compatibility projection; v2 sync authority lives in angles. */
  angle_source_ids: string[];
  angles?: TimelineMulticamAngle[];
  reference_source_id?: string | null;
  audio_source_id?: string | null;
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
  duration?: number;
  kind?: string;
  label: string;
  metadata?: Record<string, string>;
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

export interface TimelineAuthority {
  generation: string;
  revision: number;
}

export interface TimelineSnapshot {
  project: TimelineProject;
  undo_depth: number;
  redo_depth: number;
  validation: TimelineValidationIssue[];
  authority: TimelineAuthority;
}

export interface TimelinePersistenceFiles {
  project_id: string;
  checkpoint_path: string;
  journal_path: string;
  backup_path: string;
  generation: string;
  checkpoint_sequence: number;
  journal_operations: number;
  ignored_partial_tail: boolean;
}

export interface TimelineRuntimeStatus {
  project_id: string;
  authority: TimelineAuthority;
  persistence: TimelinePersistenceFiles;
  recovered_operations: number;
  used_backup: boolean;
  ignored_partial_tail: boolean;
}

export type TimelineCommand =
  | { type: "insert"; sequence_id: string; track_id: string; clip: TimelineClip }
  | { type: "overwrite"; sequence_id: string; track_id: string; clip: TimelineClip }
  | { type: "move"; sequence_id: string; clip_id: string; target_track_id: string; timeline_start: number }
  | { type: "split"; sequence_id: string; clip_id: string; position: number; right_clip_id: string }
  | { type: "trim"; sequence_id: string; clip_id: string; timeline_start: number; source_in: number; duration: number }
  | { type: "ripple_delete"; sequence_id: string; clip_id: string }
  | { type: "disable"; sequence_id: string; clip_id: string; disabled: boolean }
  | { type: "replace_take"; sequence_id: string; clip_id: string; group_id: string; source_id: string; source_in: number }
  | { type: "multicam_switch"; sequence_id: string; clip_id: string; source_id: string }
  | { type: "set_marker"; sequence_id: string; marker: TimelineMarker };

interface TimelineBridgeErrorPayload {
  message?: string;
  issues?: TimelineValidationIssue[];
}

const AUTHORITY_CONFLICT_CODES = new Set([
  "stale_timeline_authority",
  "timeline_authority_required",
]);

export class TimelineBridgeError extends Error {
  readonly issues: TimelineValidationIssue[];

  constructor(message: string, issues: TimelineValidationIssue[] = []) {
    super(message);
    this.name = "TimelineBridgeError";
    this.issues = issues;
  }
}

export function isTimelineAuthorityConflict(error: unknown): error is TimelineBridgeError {
  return error instanceof TimelineBridgeError
    && error.issues.some((issue) => AUTHORITY_CONFLICT_CODES.has(issue.code));
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
  private authority: TimelineAuthority | null = null;
  private authorityProjectId: string | null = null;

  private accept(snapshot: TimelineSnapshot): TimelineSnapshot {
    this.authority = snapshot.authority;
    this.authorityProjectId = snapshot.project.project_id;
    return snapshot;
  }

  private expectedAuthority(): TimelineAuthority {
    if (!this.authority) {
      throw new TimelineBridgeError("Timeline authority 尚未加载；请先创建、恢复或刷新时间线。");
    }
    return this.authority;
  }

  private async readSnapshot(command: string, args?: Record<string, unknown>): Promise<TimelineSnapshot> {
    return this.accept(await callTimeline<TimelineSnapshot>(command, args));
  }

  private async replaceSnapshot(
    command: string,
    projectId: string,
    args: Record<string, unknown>,
  ): Promise<TimelineSnapshot> {
    const expectedAuthority = this.authorityProjectId === projectId ? this.expectedAuthority() : null;
    const requestArgs = expectedAuthority ? { ...args, expectedAuthority } : args;
    return this.accept(await callTimeline<TimelineSnapshot>(command, requestArgs));
  }

  private async mutate(command: string, args: Record<string, unknown> = {}): Promise<TimelineSnapshot> {
    const expectedAuthority = this.expectedAuthority();
    return this.accept(await callTimeline<TimelineSnapshot>(command, { ...args, expectedAuthority }));
  }

  newProject(projectId: string, sequenceId = "main"): Promise<TimelineSnapshot> {
    return this.readSnapshot("timeline_new", { projectId, sequenceId });
  }

  load(project: TimelineProject): Promise<TimelineSnapshot> {
    return this.replaceSnapshot("timeline_load", project.project_id, { project });
  }

  openPersisted(projectId: string): Promise<TimelineSnapshot> {
    return this.readSnapshot("timeline_open_persisted", { projectId });
  }

  loadWithCommands(project: TimelineProject, commands: TimelineCommand[]): Promise<TimelineSnapshot> {
    return this.replaceSnapshot("timeline_load_with_commands", project.project_id, { project, commands });
  }

  snapshot(): Promise<TimelineSnapshot> {
    return this.readSnapshot("timeline_snapshot");
  }

  apply(command: TimelineCommand): Promise<TimelineSnapshot> {
    return this.mutate("timeline_apply", { command });
  }

  applyBatch(commands: TimelineCommand[]): Promise<TimelineSnapshot> {
    return this.mutate("timeline_apply_batch", { commands });
  }

  undo(): Promise<TimelineSnapshot> {
    return this.mutate("timeline_undo");
  }

  redo(): Promise<TimelineSnapshot> {
    return this.mutate("timeline_redo");
  }

  checkpoint(): Promise<TimelineSnapshot> {
    return this.mutate("timeline_checkpoint");
  }

  persistenceStatus(): Promise<TimelineRuntimeStatus> {
    // Status may describe a newer Rust authority than this client's last full
    // project snapshot. It is display-only and must never silently grant a new
    // mutation token without refreshing the actual Timeline snapshot.
    return callTimeline<TimelineRuntimeStatus>("timeline_persistence_status");
  }

  validate(): Promise<TimelineValidationIssue[]> {
    return callTimeline<TimelineValidationIssue[]>("timeline_validate");
  }
}
