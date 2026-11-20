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
    placements: SyncRecordingPlacement[];
  } | null;
  clip_count: number;
  duration_seconds: number;
  previous_master?: { timeline: MulticamSyncTimeline; read_at_ms: number } | null;
  /** Read-only grid proved from the generated master, never guessed from a camera. */
  timebase?: { status: "confirmed" | "unknown"; source: string; numerator?: number; denominator?: number; reason?: string };
  /** Half-open master frame intervals with no video on any camera. */
  review_gaps?: MulticamSyncGap[];
}

export interface SyncDeliveryArtifact {
  target: "davinci" | "premiere" | "final-cut" | "jianying";
  label: string;
  format: string;
  filename: string;
  available: boolean;
  unavailable_reason?: "" | "sync_not_ready" | "not_generated" | "media_roots_unbound" | "unexpected_location" | "file_missing";
  /** Device-local absolute path. This is supplied only by the localhost-only route. */
  local_path: string;
  task?: MulticamSyncTaskSummary;
  details?: { version?: string; audio_segments?: number; camera_audio_tracks?: number; delivery_kind?: string; native_multicam?: boolean; conversion_required?: boolean; conversion_instruction?: string; relocation_instruction?: string; diagnostics?: { code: string; message: string }[] };
}

export function syncDeliveryFileLabel(artifact: SyncDeliveryArtifact): string {
  if (artifact.available) return "已生成文件";
  switch (artifact.unavailable_reason) {
    case "sync_not_ready": return "等待同步完成";
    case "not_generated": return "尚未生成";
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
