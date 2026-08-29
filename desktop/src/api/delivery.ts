import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";
import type { TimelineAuthority, TimelineSnapshot } from "./timeline";

export interface DeliveryExportReport {
  version?: number;
  contract?: string;
  organized_fcpxml?: string;
  organized_fcpxml_ref?: string;
  organized_fcpxml_exists?: boolean;
  selection_manifest?: string;
  selection_manifest_ref?: string;
  selection_manifest_exists?: boolean;
  selection_contract?: string;
  selection_manifest_version?: number;
  selection_summary?: Record<string, unknown>;
  keywords_written?: boolean;
  keyword_count?: number;
  decision_ranges_written?: number;
  multicam_structure_modified?: boolean;
  warning?: string;
  persisted_report_path_safe?: boolean;
  device_paths_exposed?: boolean;
  device_paths_scope?: "localhost_response_only" | string;
  [key: string]: unknown;
}

export interface DeliveryExportPayload {
  contract: "delivery_export.v1" | string;
  report: DeliveryExportReport;
}

export interface TimelineDeliveryReport {
  version?: number;
  contract?: "timeline_delivery_report.v1" | string;
  organized_fcpxml?: string;
  organized_fcpxml_ref?: string;
  organized_fcpxml_exists?: boolean;
  timeline_authority?: TimelineAuthority;
  timeline_project_id?: string;
  sequence_id?: string;
  frame_rate?: { numerator: number; denominator: number };
  video_clip_count?: number;
  audio_track_count?: number;
  audio_clip_count?: number;
  multicam_flattened_count?: number;
  markers_not_exported?: number;
  semantics?: Record<string, boolean>;
  persisted_report_path_safe?: boolean;
  device_paths_exposed?: boolean;
  device_paths_scope?: "localhost_response_only" | string;
  [key: string]: unknown;
}

export interface TimelineDeliveryPayload {
  contract: "timeline_delivery_export.v1" | string;
  report: TimelineDeliveryReport;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

function baseProjectRoute(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("Delivery export 需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}`;
}

function legacyRoute(projectId: string): string {
  return `${baseProjectRoute(projectId)}/delivery-export`;
}

function timelineRoute(projectId: string): string {
  return `${baseProjectRoute(projectId)}/timeline-delivery-export`;
}

async function request<T>(
  baseUrl: string,
  path: string,
  method: "GET" | "POST",
  body?: object,
): Promise<T> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const response = await transportFetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
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
  return await response.json() as T;
}

export class DeliveryClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new HostConnectionError("Delivery Host 地址无效");
  }

  status(projectId: string): Promise<DeliveryExportPayload> {
    return request<DeliveryExportPayload>(this.baseUrl, legacyRoute(projectId), "GET");
  }

  export(projectId: string): Promise<DeliveryExportPayload> {
    return request<DeliveryExportPayload>(this.baseUrl, legacyRoute(projectId), "POST");
  }

  timelineStatus(projectId: string): Promise<TimelineDeliveryPayload> {
    return request<TimelineDeliveryPayload>(this.baseUrl, timelineRoute(projectId), "GET");
  }

  exportTimeline(projectId: string, snapshot: TimelineSnapshot): Promise<TimelineDeliveryPayload> {
    if (snapshot.project.project_id !== projectId.trim()) {
      throw new HostConnectionError("Timeline delivery 的 snapshot project_id 与当前项目不一致");
    }
    return request<TimelineDeliveryPayload>(
      this.baseUrl,
      timelineRoute(projectId),
      "POST",
      {
        contract: "timeline_delivery_request.v1",
        timeline: snapshot.project,
        authority: snapshot.authority,
      },
    );
  }
}
