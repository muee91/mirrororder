import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError, type ProjectSummary } from "./host";

export interface DesktopCommandStatus { name: string; available: boolean; path: string }
export interface DesktopModuleStatus { name: string; available: boolean; required: boolean }
export interface DesktopEnvironment {
  python: { executable: string; version: string };
  commands: DesktopCommandStatus[];
  python_modules: DesktopModuleStatus[];
  multicam_engine: Record<string, unknown>;
  workspaces: Array<{ path: string; exists: boolean; writable: boolean }>;
  media_directory_sync_ready: boolean;
  identity_runtime: { face: boolean; speaker: boolean };
  host: string;
  platform: string;
  data_root: string;
}
export interface DesktopStatusPayload {
  contract: "desktop_status.v1" | string;
  workspace: { workspace_id: string; name: string; path: string; projects: number };
  environment: DesktopEnvironment;
  device_media: { version: number; device_id: string; device_name: string; state_path: string };
}
export interface FrontendSettings {
  version: number;
  theme: "system" | "light" | "dark";
  density: "comfortable" | "compact";
  default_mode: "script" | "unassigned";
  default_episode: "first" | "all" | number;
  poll_interval_ms: 1000 | 2500 | 5000 | 10000;
  update_sound: boolean;
  show_unknown_count: boolean;
}
export interface RuntimeKindStatus {
  kind?: string;
  available: boolean;
  prepared?: boolean;
  preparing: boolean;
  status: string;
  cache_dir: string;
  cache_bytes: number;
  last_error?: string;
  artifacts?: Array<Record<string, unknown>>;
  dependencies?: Record<string, unknown>;
}
export interface LocalRuntimePayload {
  contract: "local_runtime.v1" | string;
  local_vision_enabled: boolean;
  local_vision_model: string;
  face_identity_enabled: boolean;
  speaker_identity_enabled: boolean;
  vision: RuntimeKindStatus & { running?: boolean; model?: string };
  identity: { face: RuntimeKindStatus; speaker: RuntimeKindStatus; root: string; python_runtime_root?: string };
  mlx_cache_bytes: number;
  model_root: string;
  environment: DesktopEnvironment;
}
export type LocalRuntimeAction =
  | { action: "set"; local_vision_enabled?: boolean; local_vision_model?: string; face_identity_enabled?: boolean; speaker_identity_enabled?: boolean }
  | { action: "prepare" }
  | { action: "prepare_identity"; kind: "face" | "speaker" }
  | { action: "stop" };
export type CollaborationRole = "viewer" | "reviewer" | "manager";
export type CollaborationStatus = "active" | "disabled";
export interface CollaborationUser {
  user_id: string;
  nickname: string;
  role: CollaborationRole;
  status: CollaborationStatus;
  created_at: string;
  updated_at: string;
  last_seen_at: string;
  last_ip: string;
  device_count: number;
}
export interface CollaborationAuditRow {
  at: string;
  event: string;
  user_id: string;
  nickname: string;
  role: CollaborationRole | string;
  ip: string;
  device_id: string;
}
export interface CollaborationPayload {
  contract: "desktop_collaboration.v1" | string;
  workspace_id: string;
  users: CollaborationUser[];
  audit: CollaborationAuditRow[];
  user?: CollaborationUser;
}
export interface MediaBindingItem { media_id: string; verified: boolean; name: string; source_media_path: string; clip_ids: string[]; resolved_path: string; local_exists: boolean }
export interface MediaBindingSummary {
  version: number; device_id: string; device_name: string; state_path: string; roots: string[];
  total: number; resolved: number; missing: number; items: MediaBindingItem[]; pending_analysis?: boolean;
  scan?: { files_seen: number; verified_matches: number; provisional_name_matches: number };
}
export interface MediaBindingPayload { contract: "media_binding.v1" | string; project_id: string; summary: MediaBindingSummary }
export interface ProjectCreatePayload {
  name: string; project_id?: string; input_kind: "fcpxml" | "media-directory"; script: string;
  fcpxml?: string; media_roots?: string[]; timeline_mode?: "sequential" | "timestamp" | string; camera_patterns?: Record<string, string>;
}
export interface ProjectPreflight { ready: boolean; errors: string[]; warnings: string[]; detected?: Record<string, unknown>; project_id?: string; [key: string]: unknown }
export interface ProjectTask { task_id?: string; status?: string; type?: string; [key: string]: unknown }
export interface ProjectDeleteResult { project_id: string; deleted: boolean; config_path: string }

const REQUEST_TIMEOUT_MS = 20_000;
async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> { return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init); }
async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await transportFetch(`${baseUrl}${path}`, { ...init, method: init?.method ?? "GET", headers, signal: controller.signal });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try { const payload = await response.json() as { error?: string }; message = payload.error || message; } catch { /* fallback */ }
      throw new HostConnectionError(message, { status: response.status });
    }
    return await response.json() as T;
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    throw new HostConnectionError(`Desktop parity API 请求失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { globalThis.clearTimeout(timeout); }
}
function projectPath(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("Desktop project API 需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}`;
}
function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("Desktop Host 地址无效");
  return value;
}

export class DesktopClient {
  readonly baseUrl: string;
  constructor(baseUrl: string) { this.baseUrl = normalizeBaseUrl(baseUrl); }
  status(): Promise<DesktopStatusPayload> { return requestJson(this.baseUrl, "/api/v1/desktop-status"); }
  frontendSettings(): Promise<FrontendSettings> { return requestJson(this.baseUrl, "/api/v1/settings"); }
  saveFrontendSettings(settings: FrontendSettings): Promise<FrontendSettings> { return requestJson(this.baseUrl, "/api/v1/settings", { method: "POST", body: JSON.stringify(settings) }); }
  localRuntime(): Promise<LocalRuntimePayload> { return requestJson(this.baseUrl, "/api/v1/desktop-local-runtime"); }
  updateLocalRuntime(action: LocalRuntimeAction): Promise<LocalRuntimePayload> { return requestJson(this.baseUrl, "/api/v1/desktop-local-runtime", { method: "POST", body: JSON.stringify(action) }); }
  collaboration(): Promise<CollaborationPayload> { return requestJson(this.baseUrl, "/api/v1/desktop-collaboration"); }
  updateCollaborator(userId: string, values: Partial<Pick<CollaborationUser, "nickname" | "role" | "status">>): Promise<CollaborationPayload> {
    const value = userId.trim();
    if (!value) throw new HostConnectionError("更新团队用户需要 user_id");
    return requestJson(this.baseUrl, `/api/v1/desktop-collaboration/${encodeURIComponent(value)}`, { method: "POST", body: JSON.stringify(values) });
  }
  mediaBinding(projectId: string): Promise<MediaBindingPayload> { return requestJson(this.baseUrl, `${projectPath(projectId)}/media-binding`); }
  scanMediaBinding(projectId: string, roots: string[], replace = false): Promise<MediaBindingPayload> {
    const normalized = [...new Set(roots.map((root) => root.trim()).filter(Boolean))];
    if (!normalized.length) throw new HostConnectionError("扫描本机素材至少需要一个目录");
    return requestJson(this.baseUrl, `${projectPath(projectId)}/media-binding`, { method: "POST", body: JSON.stringify({ action: replace ? "replace_and_scan" : "scan", roots: normalized }) });
  }
  async preflightProject(payload: ProjectCreatePayload): Promise<ProjectPreflight> {
    const response = await requestJson<{ contract: string; preflight: ProjectPreflight }>(this.baseUrl, "/api/v1/projects/preflight", { method: "POST", body: JSON.stringify(payload) });
    return response.preflight;
  }
  createProject(payload: ProjectCreatePayload): Promise<ProjectSummary> { return requestJson(this.baseUrl, "/api/v1/projects", { method: "POST", body: JSON.stringify(payload) }); }
  deleteProject(projectId: string): Promise<ProjectDeleteResult> {
    const value = projectId.trim();
    if (!value) throw new HostConnectionError("删除项目需要 project_id");
    return requestJson(this.baseUrl, `${projectPath(value)}/delete`, { method: "POST", body: JSON.stringify({ confirm_project_id: value }) });
  }
  prepareProject(projectId: string): Promise<ProjectTask> {
    return requestJson(this.baseUrl, `${projectPath(projectId)}/tasks`, { method: "POST", body: JSON.stringify({ type: "prepare_project", targets: {}, actor: "desktop-v2", idempotency_key: `desktop-v2:prepare:${projectId}` }) });
  }
}
