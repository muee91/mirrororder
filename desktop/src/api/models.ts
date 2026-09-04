import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export type ModelRole = "text" | "vision" | "embedding";
export type ModelRoutingMode = "local" | "external" | "hybrid" | "fallback";
export type ModelRoutingPrivacy = "local-only" | "external-models" | "mixed";

export const MODEL_ROUTING_CHANGED_EVENT = "mirrororder:model-routing-changed";

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

export interface EffectiveModelRoute {
  enabled: boolean;
  provider: string;
  model: string;
  local: boolean;
  source?: string;
  fallback?: string;
}

export interface EffectiveModelRouting {
  contract: string;
  mode: ModelRoutingMode;
  privacy: ModelRoutingPrivacy;
  text: EffectiveModelRoute;
  vision: EffectiveModelRoute;
  embedding: EffectiveModelRoute;
}

export interface ModelInventory {
  contract: string;
  production_rescue: Record<string, unknown>;
  vision: Record<string, unknown>;
  multimodal_audit: Record<string, unknown>;
  assistant_language: Record<string, unknown>;
  semantic_embedding: Record<string, unknown>;
}

export interface AssistantModelsPayload {
  contract?: string;
  models: ModelInventory;
  routing: EffectiveModelRouting;
  connections: ModelConnections;
  restore_error?: string;
  agent_api?: Record<string, unknown>;
}

export interface ModelConnectionWrite {
  enabled: boolean;
  provider: string;
  base_url: string;
  model: string;
  api_key?: string;
}

const DEVICE_MODEL_PATH = "/api/v1/assistant/models";

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await transportFetch(`${baseUrl}${path}`, { ...init, headers });
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

  read(): Promise<AssistantModelsPayload> {
    return request<AssistantModelsPayload>(this.baseUrl, DEVICE_MODEL_PATH);
  }

  save(connections: Record<ModelRole, ModelConnectionWrite>): Promise<AssistantModelsPayload> {
    return request<AssistantModelsPayload>(this.baseUrl, DEVICE_MODEL_PATH, {
      method: "POST",
      body: JSON.stringify(connections),
    });
  }
}
