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
  shot_type?: string;
  coverage_role?: string;
}

export interface ReviewEffectiveMapping {
  source: "human" | "automatic" | "none" | string;
  mapping_status: string;
  script_segment_ids: string[];
  episode_ids: number[];
  inherited?: boolean;
}

export interface ReviewCandidate {
  candidate_id: string;
  group_id: string;
  script_segment_id: string;
  script_segment_ids: string[];
  episode_ids: number[];
  confidence: string;
  total_score: number;
  dialogue_score: number;
  sequence_score: number;
  context_score: number;
  margin: number;
  method: string;
  transcript_text: string;
  evidence: string[];
  context_episodes: number[];
  relative_start?: number;
  relative_end?: number;
}

export interface ReviewAutomaticState {
  available?: boolean;
  status?: string;
  mapping_status?: string;
  mapping_source?: string;
  candidate_id?: string;
  script_segment_ids?: string[];
  episode_ids?: number[];
  confidence?: number;
  reason?: string;
  evidence?: Record<string, unknown>;
}

export interface ReviewLegacyManualState {
  effective_state?: string;
  group?: Record<string, unknown>;
  group_inherited?: boolean;
  placement?: {
    episode_ids?: number[];
    script_segment_ids?: string[];
    method?: string;
    updated_at?: string;
    actor?: string;
  };
  placement_inherited?: boolean;
  assignments?: unknown[];
  clips?: unknown[];
}

export interface ReviewEditorialState {
  legacy_manual?: ReviewLegacyManualState;
  individual_opinion?: unknown;
  editorial_decision?: unknown;
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
  candidates: ReviewCandidate[];
  context: { episode_ids: number[]; script_segment_ids: string[] };
  automatic_state: ReviewAutomaticState;
  editorial_state: ReviewEditorialState;
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

export interface LegacyReviewPayload {
  version: number;
  revision: number;
  updated_at: string;
  assignments: Record<string, unknown>;
  groups: Record<string, unknown>;
  clips: Record<string, unknown>;
  placements: Record<string, unknown>;
  history?: unknown[];
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
  review_state: {
    legacy_review?: LegacyReviewPayload;
    individual_opinions?: unknown[];
    editorial_decisions?: Record<string, unknown>;
  };
}

export interface ReviewPlacementWrite {
  groupId: string;
  actor: string;
  expectedRevision?: number;
  episodeIds?: number[];
  scriptSegmentIds?: string[];
  interaction?: "drag" | "click" | "keyboard" | string;
  sourceSurface?: string;
  sourceKind?: string;
  sourceClipId?: string;
}

export interface ReviewExclusionWrite {
  groupId: string;
  actor: string;
  excluded: boolean;
  expectedRevision?: number;
  interaction?: "drag" | "click" | "keyboard" | string;
  sourceSurface?: string;
  sourceClipId?: string;
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
// A real workspace can take several seconds to materialize its first project
// summaries on a cold packaged runtime. Keep this bounded, but do not let the
// startup path cancel a valid response and then amplify the work with retries.
const REQUEST_TIMEOUT_MS = 20_000;

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

type TauriRequestInit = RequestInit & { connectTimeout?: number };

async function transportFetch(input: RequestInfo | URL, init?: TauriRequestInit, tauriRuntime = isTauri()): Promise<Response> {
  return tauriRuntime ? tauriFetch(input, init) : globalThis.fetch(input, init);
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

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const tauriRuntime = isTauri();
  const controller = new AbortController();
  let timeout: ReturnType<typeof globalThis.setTimeout> | undefined;
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const requestInit: TauriRequestInit = {
    ...init,
    method: init?.method ?? "GET",
    headers,
  };
  if (tauriRuntime) {
    // tauri-plugin-http's AbortSignal cancellation can leave a cold managed
    // localhost request pending. Use its bounded connect window and a JS
    // deadline instead; browser fetch keeps native AbortSignal semantics.
    requestInit.connectTimeout = REQUEST_TIMEOUT_MS;
  } else {
    requestInit.signal = controller.signal;
  }
  try {
    const deadline = new Promise<never>((_, reject) => {
      timeout = globalThis.setTimeout(() => {
        if (!tauriRuntime) controller.abort();
        reject(new HostConnectionError(`Host 请求超过 ${REQUEST_TIMEOUT_MS / 1000} 秒未响应`));
      }, REQUEST_TIMEOUT_MS);
    });
    const response = await Promise.race([
      transportFetch(`${baseUrl}${path}`, requestInit, tauriRuntime),
      deadline,
    ]);
    if (!response.ok) {
      throw new HostConnectionError(await decodeError(response), { status: response.status });
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HostConnectionError(`无法连接镜序 Host：${message}`, { cause: error });
  } finally {
    if (timeout !== undefined) globalThis.clearTimeout(timeout);
  }
}

function normalizedProjectId(projectId: string, action: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError(`${action}需要 project_id`);
  return value;
}

function normalizedActor(actor: string): string {
  const value = actor.trim();
  if (!value) throw new HostConnectionError("写入人工归集前需要审核昵称");
  return value.slice(0, 80);
}

function normalizedGroupId(groupId: string): string {
  const value = groupId.trim();
  if (!value) throw new HostConnectionError("写入人工归集需要 group_id");
  return value;
}

function normalizedExpectedRevision(value: number | undefined, action: string): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || value < 0) {
    throw new HostConnectionError(`${action}需要有效 expected_revision`);
  }
  return value;
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

  mediaUrl(projectId: string, clipId: string): string {
    const project = projectId.trim();
    const clip = clipId.trim();
    if (!project || !clip) {
      throw new HostConnectionError("读取媒体需要 project_id 与 clip_id");
    }
    return `${this.baseUrl}/api/v1/projects/${encodeURIComponent(project)}/media/${encodeURIComponent(clip)}`;
  }

  async reviewModel(projectId: string): Promise<ReviewModelPayload> {
    const project = normalizedProjectId(projectId, "读取 review-model ");
    const payload = await requestJson<ReviewModelPayload>(
      this.baseUrl,
      `/api/v1/projects/${encodeURIComponent(project)}/review-model`,
    );
    if (payload.contract_version !== "review.v1") {
      throw new HostConnectionError(`不支持的 review-model contract：${payload.contract_version || "missing"}`);
    }
    if (payload.project?.project_id && payload.project.project_id !== project) {
      throw new HostConnectionError(
        `review-model project_id 不匹配：请求 ${project}，返回 ${payload.project.project_id}`,
      );
    }
    return payload;
  }

  async setGroupPlacement(projectId: string, write: ReviewPlacementWrite): Promise<LegacyReviewPayload> {
    const project = normalizedProjectId(projectId, "写入人工归集");
    const groupId = normalizedGroupId(write.groupId);
    const actor = normalizedActor(write.actor);
    const expectedRevision = normalizedExpectedRevision(write.expectedRevision, "写入人工归集");
    const episodeIds = [...new Set(write.episodeIds ?? [])]
      .filter((value) => Number.isInteger(value) && value > 0 && value < 10000)
      .sort((left, right) => left - right);
    const scriptSegmentIds = [...new Set((write.scriptSegmentIds ?? []).map((value) => value.trim()).filter(Boolean))];
    if (episodeIds.length === 0 && scriptSegmentIds.length === 0) {
      throw new HostConnectionError("人工归集至少需要 episode_id 或 script_segment_id");
    }
    return requestJson<LegacyReviewPayload>(
      this.baseUrl,
      `/api/v1/projects/${encodeURIComponent(project)}/review`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "set_group_placement",
          group_id: groupId,
          episode_ids: episodeIds,
          script_segment_ids: scriptSegmentIds,
          actor,
          interaction: write.interaction ?? "click",
          source_surface: write.sourceSurface ?? "desktop-v2",
          source_kind: write.sourceKind ?? "take",
          source_clip_id: write.sourceClipId?.trim() || undefined,
          ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
        }),
      },
    );
  }

  async clearGroupPlacement(projectId: string, write: Pick<ReviewPlacementWrite, "groupId" | "actor" | "expectedRevision" | "interaction" | "sourceSurface" | "sourceKind" | "sourceClipId">): Promise<LegacyReviewPayload> {
    const project = normalizedProjectId(projectId, "清除人工归集");
    const groupId = normalizedGroupId(write.groupId);
    const actor = normalizedActor(write.actor);
    const expectedRevision = normalizedExpectedRevision(write.expectedRevision, "清除人工归集");
    return requestJson<LegacyReviewPayload>(
      this.baseUrl,
      `/api/v1/projects/${encodeURIComponent(project)}/review`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "clear_group_placement",
          group_id: groupId,
          actor,
          interaction: write.interaction ?? "click",
          source_surface: write.sourceSurface ?? "desktop-v2",
          source_kind: write.sourceKind ?? "take",
          source_clip_id: write.sourceClipId?.trim() || undefined,
          ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
        }),
      },
    );
  }

  async setGroupExclusion(projectId: string, write: ReviewExclusionWrite): Promise<LegacyReviewPayload> {
    const project = normalizedProjectId(projectId, "写入素材排除状态");
    const groupId = normalizedGroupId(write.groupId);
    const actor = normalizedActor(write.actor);
    const expectedRevision = normalizedExpectedRevision(write.expectedRevision, "写入素材排除状态");
    return requestJson<LegacyReviewPayload>(
      this.baseUrl,
      `/api/v1/projects/${encodeURIComponent(project)}/review`,
      {
        method: "POST",
        body: JSON.stringify({
          action: "set_group",
          group_id: groupId,
          state: write.excluded ? "reject" : "unreviewed",
          actor,
          interaction: write.interaction ?? "click",
          source_surface: write.sourceSurface ?? "desktop-v2-slate-table",
          source_kind: "take",
          source_clip_id: write.sourceClipId?.trim() || undefined,
          ...(expectedRevision === undefined ? {} : { expected_revision: expectedRevision }),
        }),
      },
    );
  }

  async connect(): Promise<HostSnapshot> {
    const ping = await this.ping();
    if (ping.status !== "ok") {
      throw new HostConnectionError(`Host ping 返回异常状态：${ping.status}`);
    }
    const workspace = await this.workspace();
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
    // startLocal() already returns only after Rust has verified the managed
    // child as mirrororder-host. One bounded read is enough here; retrying the
    // full workspace projection after an AbortSignal timeout can pile up
    // expensive real-project reads and leave the UI stuck in "starting".
    return await connection.connect();
  }
}

export const defaultHostBaseUrl = DEFAULT_BASE_URL;
