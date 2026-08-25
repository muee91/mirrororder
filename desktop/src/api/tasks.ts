import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export interface ProjectTaskRecord {
  task_id: string;
  project_id?: string;
  type: string;
  status: string;
  stage: string;
  message?: string | null;
  progress?: Record<string, number> | null;
  error?: string | null;
  targets?: Record<string, unknown>;
  idempotency_key?: string;
  actor?: string;
  cancel_requested?: boolean;
  created_at?: string | null;
  started_at?: string | null;
  completed_at?: string | null;
}

const REQUEST_TIMEOUT_MS = 20_000;
const CANCELLABLE = new Set(["queued", "running"]);
const RETRYABLE = new Set(["failed", "cancelled", "interrupted"]);

function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("Desktop Host 地址无效");
  return value;
}

function projectPath(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("Task API 需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}`;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await transportFetch(`${baseUrl}${path}`, {
      ...init,
      method: init?.method ?? "GET",
      headers,
      signal: controller.signal,
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
    return await response.json() as T;
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    throw new HostConnectionError(`后台任务请求失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export function canCancelTask(task: Pick<ProjectTaskRecord, "status">): boolean {
  return CANCELLABLE.has(task.status);
}

export function canRetryTask(task: Pick<ProjectTaskRecord, "status">): boolean {
  return RETRYABLE.has(task.status);
}

export function retryTaskBody(task: ProjectTaskRecord): Record<string, unknown> {
  if (!canRetryTask(task)) throw new HostConnectionError(`任务状态 ${task.status} 不能重试`);
  if (!task.type.trim()) throw new HostConnectionError("任务缺少 type，不能重试");
  return {
    type: task.type,
    targets: task.targets && typeof task.targets === "object" ? task.targets : {},
    actor: "desktop",
    // The durable TaskManager deliberately permits the same idempotency key
    // after failed/cancelled/interrupted states while still deduplicating
    // queued/running/completed tasks.
    idempotency_key: task.idempotency_key || `desktop:retry:${task.task_id}`,
  };
}

export class ProjectTaskClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  async list(projectId: string): Promise<ProjectTaskRecord[]> {
    const payload = await requestJson<{ tasks: ProjectTaskRecord[] }>(this.baseUrl, `${projectPath(projectId)}/tasks`);
    return Array.isArray(payload.tasks) ? payload.tasks : [];
  }

  cancel(projectId: string, taskId: string): Promise<ProjectTaskRecord> {
    const value = taskId.trim();
    if (!value) throw new HostConnectionError("取消任务需要 task_id");
    return requestJson(this.baseUrl, `${projectPath(projectId)}/tasks/${encodeURIComponent(value)}`, {
      method: "POST",
      body: JSON.stringify({ action: "cancel" }),
    });
  }

  retry(projectId: string, task: ProjectTaskRecord): Promise<ProjectTaskRecord> {
    return requestJson(this.baseUrl, `${projectPath(projectId)}/tasks`, {
      method: "POST",
      body: JSON.stringify(retryTaskBody(task)),
    });
  }
}
