import { invoke, isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";

export type HostConnectionState =
  | "idle"
  | "connecting"
  | "starting"
  | "connected"
  | "error";

export interface HostPing {
  status: string;
  service: string;
}

export interface ProjectSummary {
  project_id: string;
  name: string;
  input_kind: string;
  analysis_revision?: string;
  stats?: Record<string, unknown>;
  errors?: unknown;
  source?: unknown;
  local_media?: unknown;
  error?: string;
}

export interface WorkspacePayload {
  workspace_id: string;
  workspace: string;
  api_version: string;
  projects: ProjectSummary[];
}

export interface HostSnapshot {
  baseUrl: string;
  ping: HostPing;
  workspace: WorkspacePayload;
  projects: ProjectSummary[];
}

export interface HostLaunchResult {
  pid: number;
  base_url: string;
  already_running: boolean;
}

export interface HostProcessStatus {
  running: boolean;
  pid: number | null;
  base_url: string | null;
  workspace_path: string | null;
}

export interface ReviewIssue {
  code: string;
  severity: string;
  label: string;
}

export interface ReviewPlayback {
  url: string;
  source_start: number;
  source_end: number | null;
  available?: boolean;
}

export interface ReviewAngle {
  clip_id: string;
  media_id: string;
  camera: string;
  name: string;
  timeline_start: number;
  timeline_end: number;
  duration: number;
  source_start: number;
  source_end: number | null;
  playback: ReviewPlayback;
}

export interface ReviewEffectiveMapping {
  source: "human" | "automatic" | "none" | string;
  mapping_status: string;
  script_segment_ids: string[];
  episode_ids: number[];
  inherited?: boolean;
}

export interface ReviewTakeGroup {
  group_id: string;
  parent_group_id: string;
  kind: string;
  take_index: number;
  split_reason: string;
  start: number;
  end: number;
  duration: number;
  cameras: string[];
  angles: ReviewAngle[];
  transcript: { text: string; source: string };
  people: { faces: unknown[]; speakers: unknown[] };
  candidates: unknown[];
  context: { episode_ids: number[]; script_segment_ids: string[] };
  automatic_state: Record<string, unknown>;
  editorial_state: Record<string, unknown>;
  effective_mapping: ReviewEffectiveMapping;
  issues: ReviewIssue[];
}

export interface ReviewScriptBlock {
  segment_id: string;
  episode: number;
  scene_id: string;
  order: number;
  type: string;
  speaker: string;
  text: string;
  raw_text: string;
  issues: ReviewIssue[];
}

export interface ReviewScene {
  scene_id: string;
  heading: string;
  script_blocks: ReviewScriptBlock[];
  take_group_ids: string[];
}

export interface ReviewEpisode {
  episode: number;
  scenes: ReviewScene[];
}

export interface ReviewModelPayload {
  contract_version: string;
  project: {
    project_id: string;
    name: string;
    input_kind: string;
    stats: Record<string, unknown>;
    local_media: Record<string, number>;
    issues: ReviewIssue[];
  };
  revisions: {
    analysis: string;
    automation_analysis: string;
    automation_updated_at: string;
    review: number;
  };
  capabilities: Record<string, boolean>;
  summary: {
    automation: Record<string, unknown>;
    script_gaps: number;
    take_groups: number;
    episodes: number;
  };
  episodes: ReviewEpisode[];
  take_groups: ReviewTakeGroup[];
  script_gaps: unknown[];
  review_state: Record<string, unknown>;
}

interface ErrorPayload {
  error?: string;
}

export class HostConnectionError extends Error {
  readonly status?: number;
  readonly causeValue?: unknown;

  constructor(message: string, options?: { status?: number; cause?: unknown }) {
    super(message);
    this.name = "HostConnectionError";
    this.status = options?.status;
    this.causeValue = options?.cause;
  }
}

const DEFAULT_BASE_URL = "http://127.0.0.1:8765";
const REQUEST_TIMEOUT_MS = 5000;

function normalizeBaseUrl(value: string): string {
  const normalized = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(normalized)) {
    throw new HostConnectionError("Host 地址必须以 http:// 或 https:// 开头");
  }
  return normalized;
}

function requireTauriRuntime(action: string): void {
  if (!isTauri()) {
    throw new HostConnectionError(`浏览器预览无法${action}本地 Python Host，请在 Tauri App 中运行`);
  }
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function decodeError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as ErrorPayload;
    if (payload.error) return payload.error;
  } catch {
    // Fall through to a stable transport-level message.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function requestJson<T>(baseUrl: string, path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await transportFetch(`${baseUrl}${path}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HostConnectionError(await decodeError(response), { status: response.status });
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HostConnectionError(`无法连接镜序 Host：${message}`, { cause: error });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export class HostConnection {
  readonly baseUrl: string;

  constructor(baseUrl = DEFAULT_BASE_URL) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  ping(): Promise<HostPing> {
    return requestJson<HostPing>(this.baseUrl, "/api/v1/ping");
  }

  workspace(): Promise<WorkspacePayload> {
    return requestJson<WorkspacePayload>(this.baseUrl, "/api/v1/workspace");
  }

  async projects(): Promise<ProjectSummary[]> {
    return (await this.workspace()).projects;
  }

  async reviewModel(projectId: string): Promise<ReviewModelPayload> {
    const normalizedProjectId = projectId.trim();
    if (!normalizedProjectId) {
      throw new HostConnectionError("读取 review-model 需要 project_id");
    }
    const payload = await requestJson<ReviewModelPayload>(
      this.baseUrl,
      `/api/v1/projects/${encodeURIComponent(normalizedProjectId)}/review-model`,
    );
    if (payload.contract_version !== "review.v1") {
      throw new HostConnectionError(`不支持的 review-model contract：${payload.contract_version || "missing"}`);
    }
    if (payload.project?.project_id && payload.project.project_id !== normalizedProjectId) {
      throw new HostConnectionError(
        `review-model project_id 不匹配：请求 ${normalizedProjectId}，返回 ${payload.project.project_id}`,
      );
    }
    return payload;
  }

  async connect(): Promise<HostSnapshot> {
    const [ping, workspace] = await Promise.all([this.ping(), this.workspace()]);
    if (ping.status !== "ok") {
      throw new HostConnectionError(`Host ping 返回异常状态：${ping.status}`);
    }
    if (!Array.isArray(workspace.projects)) {
      throw new HostConnectionError("Host workspace 响应缺少 projects 列表");
    }
    return {
      baseUrl: this.baseUrl,
      ping,
      workspace,
      projects: workspace.projects,
    };
  }

  async startLocal(workspacePath: string, port = 8765): Promise<HostLaunchResult> {
    requireTauriRuntime("启动");
    const path = workspacePath.trim();
    if (!path) {
      throw new HostConnectionError("启动 Host 前需要 workspace.toml 或工作区目录路径");
    }
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new HostConnectionError("Host 端口必须是 1–65535 的整数");
    }
    try {
      return await invoke<HostLaunchResult>("start_python_host", {
        workspacePath: path,
        port,
      });
    } catch (error) {
      throw new HostConnectionError(`启动 Python Host 失败：${String(error)}`, { cause: error });
    }
  }

  async managedStatus(): Promise<HostProcessStatus> {
    requireTauriRuntime("检查");
    try {
      return await invoke<HostProcessStatus>("host_process_status");
    } catch (error) {
      throw new HostConnectionError(`读取 Python Host 状态失败：${String(error)}`, { cause: error });
    }
  }

  async stopLocal(): Promise<void> {
    requireTauriRuntime("停止");
    try {
      await invoke("stop_python_host");
    } catch (error) {
      throw new HostConnectionError(`停止 Python Host 失败：${String(error)}`, { cause: error });
    }
  }

  async startAndConnect(workspacePath: string, port = 8765): Promise<HostSnapshot> {
    const launched = await this.startLocal(workspacePath, port);
    const connection = new HostConnection(launched.base_url);
    let lastError: unknown;
    for (let attempt = 0; attempt < 24; attempt += 1) {
      try {
        return await connection.connect();
      } catch (error) {
        lastError = error;
        await delay(250);
      }
    }
    throw new HostConnectionError("Python Host 已启动，但在就绪窗口内未通过 ping", { cause: lastError });
  }
}

export const defaultHostBaseUrl = DEFAULT_BASE_URL;
