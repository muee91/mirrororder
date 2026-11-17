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
}

export interface MulticamSyncTrack {
  track_id: string;
  kind: "video";
  camera: string;
  label: string;
  clip_count: number;
  clips: MulticamSyncClip[];
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
  clip_count: number;
  duration_seconds: number;
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
