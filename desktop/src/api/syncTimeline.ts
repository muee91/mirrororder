import { HostConnectionError } from "./host";
import { fetchWithTimeout } from "./requestWithTimeout";

export type MulticamSyncPhase =
  | "not-required"
  | "loading"
  | "required"
  | "running"
  | "completed"
  | "cancelled"
  | "interrupted"
  | "failed"
  | "invalid"
  | "unavailable";

export interface MulticamSyncTaskSummary {
  task_id: string;
  status: string;
  stage: string;
  cancel_requested?: boolean;
  message: string;
  progress?: Record<string, unknown>;
  created_at?: string;
  started_at?: string;
  completed_at?: string;
  updated_at?: string;
  error?: string;
}

export interface MulticamSyncClip {
  clip_id: string;
  day: string;
  camera: string;
  name: string;
  timeline_start: number;
  duration: number;
  timecode: string;
  clip_number: string;
  /** Host clip_id resolved through one unambiguous content identity. Empty means no safe preview. */
  media_clip_id?: string;
  manual_offset_frames?: number;
}

export interface MulticamSyncTrack {
  track_id: string;
  kind: "video";
  camera: string;
  label: string;
  clip_count: number;
  clips: MulticamSyncClip[];
}

export interface MulticamSyncGap {
  start_frame: number;
  end_frame: number;
}

export interface SyncRecordingPlacement {
  media_id: string;
  name: string;
  at: number;
  source: number;
  frames: number;
  manual_offset_frames?: number;
}

export interface SyncRecordingCandidate {
  media_id: string;
  name: string;
  status: string;
  sample_rate?: number;
  sample_count?: number;
  channels?: number;
  audio_role_hint?: { role?: string; sync_eligible?: boolean };
  clock_hint?: Record<string, string | number>;
}

export interface SyncRecordingSummary {
  status: "confirmed" | "partial" | "unconfirmed" | "not_scanned" | "no_candidates" | string;
  candidate_count: number;
  placed_count: number;
  unplaced_count: number;
  invalid_count: number;
  sync_task_id?: string;
  alignment_revision?: number;
}

export interface SyncManualOffsetEntry {
  revision: number;
  at: string;
  actor: string;
  target_kind: "clip" | "recording";
  scope: "single" | "following" | "track";
  delta_frames: number;
  clip_ids: string[];
  recording_ids: string[];
  note?: string;
}

export interface SyncManualOffsetWrite {
  target_kind: "clip" | "recording";
  scope: "single" | "following" | "track";
  delta_frames: number;
  track_id?: string;
  clip_id?: string;
  media_id?: string;
  expected_revision?: number;
  actor?: string;
  note?: string;
}

export interface SyncRecordingConfirmation {
  media_id: string;
  at: number;
  source?: number;
  frames?: number;
  expected_revision?: number;
}

export interface SyncEnrichedDeliveryManifest {
  contract: "sync_enriched_delivery.v1";
  project_id: string;
  generated_at: string;
  sync_task_id: string;
  offset_revision: number;
  bundle_dir: string;
  master_fcpxml: string;
  marker_count: number;
  scene_sequences: Array<{ scene: string; filename: string; local_path: string }>;
  dialogue_srt: string;
  srt_cue_count: number;
}

export interface MulticamSyncTimeline {
  contract_version: "multicam_sync_timeline.v1" | string;
  project_id: string;
  phase: MulticamSyncPhase;
  ready: boolean;
  message: string;
  task: MulticamSyncTaskSummary | null;
  tracks: MulticamSyncTrack[];
  cameras: string[];
  recordings?: {
    candidate_count: number;
    unplaced_count: number;
    invalid_count: number;
    candidates?: SyncRecordingCandidate[];
    placements: SyncRecordingPlacement[];
    alignment_revision?: number;
  } | null;
  recording_summary?: SyncRecordingSummary;
  clip_count: number;
  duration_seconds: number;
  previous_master?: { timeline: MulticamSyncTimeline; read_at_ms: number } | null;
  /** Read-only grid proved from the generated master, never guessed from a camera. */
  timebase?: { status: "confirmed" | "unknown"; source: string; numerator?: number; denominator?: number; reason?: string };
  /** Half-open master frame intervals with no video on any camera. */
  review_gaps?: MulticamSyncGap[];
  offset_revision?: number;
  offset_history?: SyncManualOffsetEntry[];
  stale_offset_revision?: number;
  stale_offset_sync_task_id?: string;
}

export function syncRecordingStatusLabel(timeline: Pick<MulticamSyncTimeline, "recordings" | "recording_summary">): { label: string; state: string } {
  const summary = timeline.recording_summary;
  if (!summary) {
    const count = timeline.recordings?.placements.length ?? 0;
    return { label: count ? `${count} 段已上轨` : "同步后统计", state: count ? "confirmed" : "unknown" };
  }
  switch (summary.status) {
    case "confirmed": return { label: `${summary.placed_count} 段已对齐`, state: "confirmed" };
    case "partial": return { label: `${summary.placed_count}/${summary.candidate_count} 段已对齐`, state: "partial" };
    case "unconfirmed": return { label: `${summary.candidate_count} 个待确认`, state: "unconfirmed" };
    case "no_candidates": return { label: "未发现独立录音", state: "empty" };
    case "not_scanned": return { label: "未纳入本次同步", state: "not-scanned" };
    default: return { label: "状态待确认", state: "unknown" };
  }
}

export interface SyncDeliveryArtifact {
  target: "davinci" | "premiere" | "final-cut" | "jianying";
  label: string;
  format: string;
  filename: string;
  available: boolean;
  unavailable_reason?: "" | "sync_not_ready" | "not_generated" | "not_supported" | "generation_failed" | "media_roots_unbound" | "unexpected_location" | "file_missing";
  stale?: boolean;
  stale_reason?: string;
  /** Device-local absolute path. This is supplied only by the localhost-only route. */
  local_path: string;
  task?: MulticamSyncTaskSummary;
  details?: { version?: string; audio_segments?: number; camera_audio_tracks?: number; delivery_kind?: string; native_multicam?: boolean; conversion_required?: boolean; conversion_instruction?: string; relocation_instruction?: string; diagnostics?: { code: string; message: string }[] };
}

export function syncDeliveryFileLabel(artifact: SyncDeliveryArtifact): string {
  if (artifact.stale) return "需要按当前修正版重新交付";
  if (artifact.available) return "已生成文件";
  switch (artifact.unavailable_reason) {
    case "sync_not_ready": return "等待同步完成";
    case "not_generated": return "尚未生成";
    case "not_supported": return "当前版本未提供";
    case "generation_failed": return "生成失败，需要处理";
    case "media_roots_unbound": return "本机素材目录未登记";
    case "unexpected_location": return "交付文件位置待确认";
    case "file_missing": return "交付文件未找到";
    default: return "文件不可用";
  }
}

export interface SyncDeliveryArtifacts {
  contract: "sync_delivery_artifacts.v1";
  project_id: string;
  ready: boolean;
  paths_scope: "localhost_response_only";
  validation: string;
  sync_version?: string;
  sync_task_id?: string;
  offset_revision?: number;
  delivery_state?: "current" | "stale" | string;
  stale_reasons?: string[];
  artifacts: SyncDeliveryArtifact[];
}

function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("Desktop Host 地址无效");
  return value;
}

function projectPath(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("读取多机位时间线需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}`;
}

export class SyncTimelineClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async readArtifacts(projectId: string): Promise<SyncDeliveryArtifacts> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-delivery-artifacts`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) throw new HostConnectionError(`同步工程读取失败：${response.status} ${response.statusText}`, { status: response.status });
    const result = await response.json() as SyncDeliveryArtifacts;
    if (!result || result.contract !== "sync_delivery_artifacts.v1" || result.paths_scope !== "localhost_response_only" || !Array.isArray(result.artifacts)) {
      throw new HostConnectionError("同步工程清单格式不受支持");
    }
    return result;
  }

  async createResolveDelivery(projectId: string): Promise<void> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/resolve-delivery`, {
      method: "POST", headers: { "Content-Type": "application/json", Accept: "application/json" }, body: "{}",
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new HostConnectionError(payload?.error || `Resolve 工程生成失败（${response.status}）`, { status: response.status });
    }
  }

  async applyOffset(projectId: string, body: SyncManualOffsetWrite): Promise<MulticamSyncTimeline> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-offsets`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new HostConnectionError(payload?.error || `偏移修正保存失败（${response.status}）`, { status: response.status });
    }
    return await response.json() as MulticamSyncTimeline;
  }

  async confirmRecordingPlacement(projectId: string, body: SyncRecordingConfirmation): Promise<MulticamSyncTimeline> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-recordings/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new HostConnectionError(payload?.error || `录音摆位保存失败（${response.status}）`, { status: response.status });
    }
    return await response.json() as MulticamSyncTimeline;
  }

  async undoOffset(projectId: string, expectedRevision?: number): Promise<MulticamSyncTimeline> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-offsets/undo`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(expectedRevision !== undefined ? { expected_revision: expectedRevision } : {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new HostConnectionError(payload?.error || `撤销偏移失败（${response.status}）`, { status: response.status });
    }
    return await response.json() as MulticamSyncTimeline;
  }

  async rebaseOffsets(projectId: string, expectedStaleRevision?: number): Promise<MulticamSyncTimeline> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-offsets/rebase`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(expectedStaleRevision !== undefined ? { expected_stale_revision: expectedStaleRevision } : {}),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new HostConnectionError(payload?.error || `重应用偏移失败（${response.status}）`, { status: response.status });
    }
    return await response.json() as MulticamSyncTimeline;
  }

  async createEnrichedDelivery(
    projectId: string,
    options: { include_markers?: boolean; split_by_scene?: boolean; export_srt?: boolean } = {},
  ): Promise<SyncEnrichedDeliveryManifest> {
    const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-delivery-enriched`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(options),
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => null) as { error?: string } | null;
      throw new HostConnectionError(payload?.error || `增强交付包生成失败（${response.status}）`, { status: response.status });
    }
    return await response.json() as SyncEnrichedDeliveryManifest;
  }

  async read(projectId: string): Promise<MulticamSyncTimeline> {
    try {
      const response = await fetchWithTimeout(`${this.baseUrl}${projectPath(projectId)}/sync-timeline`, {
        headers: { Accept: "application/json" },
      });
      if (!response.ok) {
        let message = `${response.status} ${response.statusText}`.trim();
        try {
          const payload = await response.json() as { error?: string };
          message = payload.error || message;
        } catch {
          // Preserve the HTTP fallback message.
        }
        throw new HostConnectionError(message, { status: response.status });
      }
      const payload = await response.json() as MulticamSyncTimeline;
      if (!payload || typeof payload !== "object" || !payload.contract_version?.startsWith("multicam_sync_timeline.")) {
        throw new HostConnectionError("不支持的多机位时间线 contract");
      }
      return payload;
    } catch (error) {
      if (error instanceof HostConnectionError) throw error;
      throw new HostConnectionError(`多机位时间线读取失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  }
}
