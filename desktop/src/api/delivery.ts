import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export interface DeliveryExportReport {
  organized_fcpxml?: string;
  organized_fcpxml_exists?: boolean;
  selection_manifest?: string;
  selection_manifest_exists?: boolean;
  selection_contract?: string;
  selection_manifest_version?: number;
  selection_summary?: Record<string, unknown>;
  keywords_written?: boolean;
  multicam_structure_modified?: boolean;
  warning?: string;
  device_paths_exposed?: boolean;
  [key: string]: unknown;
}

export interface DeliveryExportPayload {
  contract: "delivery_export.v1" | string;
  report: DeliveryExportReport;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

function route(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("Delivery export 需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}/delivery-export`;
}

async function request(baseUrl: string, projectId: string, method: "GET" | "POST"): Promise<DeliveryExportPayload> {
  const response = await transportFetch(`${baseUrl}${route(projectId)}`, {
    method,
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`.trim();
    try {
      const payload = await response.json() as { error?: string };
      message = payload.error || message;
    } catch {
      // Keep stable HTTP fallback.
    }
    throw new HostConnectionError(message, { status: response.status });
  }
  return await response.json() as DeliveryExportPayload;
}

export class DeliveryClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new HostConnectionError("Delivery Host 地址无效");
  }

  status(projectId: string): Promise<DeliveryExportPayload> {
    return request(this.baseUrl, projectId, "GET");
  }

  export(projectId: string): Promise<DeliveryExportPayload> {
    return request(this.baseUrl, projectId, "POST");
  }
}
