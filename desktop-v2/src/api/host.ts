import { invoke } from "@tauri-apps/api/core";
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
  project: string;
  input_kind: string;
  analysis_revision?: string;
  stats?: Record<string, unknown>;
  errors?: unknown;
  source?: unknown;
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

function isTauriRuntime(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauriRuntime() ? tauriFetch(input, init) : globalThis.fetch(input, init);
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
  const timeout = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
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
    window.clearTimeout(timeout);
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise((resolve) => window.setTimeout(resolve, ms));
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

  async connect(): Promise<HostSnapshot> {
    const [ping, workspace] = await Promise.all([this.ping(), this.workspace()]);
    if (ping.status !== "ok") {
      throw new HostConnectionError(`Host ping 返回异常状态：${ping.status}`);
    }
    return {
      baseUrl: this.baseUrl,
      ping,
      workspace,
      projects: workspace.projects,
    };
  }

  async startLocal(workspacePath: string, port = 8765): Promise<HostLaunchResult> {
    if (!isTauriRuntime()) {
      throw new HostConnectionError("浏览器预览无法启动本地 Python Host，请在 Tauri App 中运行");
    }
    const path = workspacePath.trim();
    if (!path) {
      throw new HostConnectionError("启动 Host 前需要 workspace.toml 或工作区目录路径");
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
