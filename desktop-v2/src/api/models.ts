import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export type ModelRole = "text" | "vision" | "embedding";

export interface ModelConnection {
  enabled: boolean;
  provider: string;
  base_url: string;
  model: string;
  has_api_key: boolean;
}

export interface ModelConnections {
  version: number;
  text: ModelConnection;
  vision: ModelConnection;
  embedding: ModelConnection;
}

export interface ModelInventory {
  contract: string;
  production_rescue: Record<string, unknown>;
  vision: Record<string, unknown>;
  multimodal_audit: Record<string, unknown>;
  assistant_language: Record<string, unknown>;
}

export interface AssistantModelsPayload {
  models: ModelInventory;
  connections: ModelConnections;
  agent_api?: Record<string, unknown>;
}

export interface ModelConnectionWrite {
  enabled: boolean;
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
}

function projectPath(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("模型设置需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}/assistant/models`;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await transportFetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Accept": "application/json", ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}), ...init?.headers },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = await response.json() as { error?: string };
      message = payload.error || message;
    } catch {
      // Keep HTTP fallback.
    }
    throw new HostConnectionError(message, { status: response.status });
  }
  return await response.json() as T;
}

export class ModelSettingsClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new HostConnectionError("模型设置 Host 地址无效");
  }

  read(projectId: string): Promise<AssistantModelsPayload> {
    return request<AssistantModelsPayload>(this.baseUrl, projectPath(projectId));
  }

  save(projectId: string, connections: Record<ModelRole, ModelConnectionWrite>): Promise<AssistantModelsPayload> {
    return request<AssistantModelsPayload>(this.baseUrl, projectPath(projectId), {
      method: "POST",
      body: JSON.stringify(connections),
    });
  }
}
