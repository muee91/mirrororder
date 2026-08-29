import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export interface ProjectLocalLocation {
  contract: "project_local_location.v1" | string;
  project_id: string;
  project_dir: string;
  output_dir: string;
  project_exists: boolean;
  output_exists: boolean;
  device_paths_exposed: true;
  scope: "device_local_response" | string;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

export class ProjectActionClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const value = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("Project action Host 地址无效");
    this.baseUrl = value;
  }

  async localLocation(projectId: string): Promise<ProjectLocalLocation> {
    const project = projectId.trim();
    if (!project) throw new HostConnectionError("项目定位需要 project_id");
    const response = await transportFetch(`${this.baseUrl}/api/v1/projects/${encodeURIComponent(project)}/local-location`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      let message = `${response.status} ${response.statusText}`.trim();
      try {
        const payload = await response.json() as { error?: string };
        message = payload.error || message;
      } catch {
        // Stable HTTP fallback.
      }
      throw new HostConnectionError(message, { status: response.status });
    }
    const payload = await response.json() as ProjectLocalLocation;
    if (payload.scope !== "device_local_response" || payload.device_paths_exposed !== true) {
      throw new HostConnectionError("项目定位返回了非 device-local 契约");
    }
    return payload;
  }
}
