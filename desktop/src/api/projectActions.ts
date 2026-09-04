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

export interface ProjectPackageInspection {
  format: string;
  schema_version: number;
  legacy: boolean;
  project_id: string;
  name: string;
  package_path: string;
  device_path_exposed: true;
  scope: "device_local_response" | string;
}

export interface ProjectTransferTask {
  task_id?: string;
  project_id?: string;
  scope?: string;
  type?: string;
  status?: string;
  stage?: string;
  [key: string]: unknown;
}

export interface ProjectImportSubmission {
  contract: "project_package_import.v1" | string;
  package: ProjectPackageInspection;
  task: ProjectTransferTask;
}

export interface ProjectTransferSubmission {
  contract: "project_transfer_task.v1" | string;
  project_id: string;
  operation: "save-as" | "collect" | string;
  task: ProjectTransferTask;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  const response = await transportFetch(`${baseUrl}${path}`, {
    ...init,
    headers,
    method: init?.method ?? "GET",
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
  return await response.json() as T;
}

function projectPath(projectId: string): string {
  const project = projectId.trim();
  if (!project) throw new HostConnectionError("项目操作需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(project)}`;
}

function localPath(value: string, label: string): string {
  const path = value.trim();
  if (!path) throw new HostConnectionError(`${label}需要本机路径`);
  return path;
}

export class ProjectActionClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const value = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("Project action Host 地址无效");
    this.baseUrl = value;
  }

  async localLocation(projectId: string): Promise<ProjectLocalLocation> {
    const payload = await requestJson<ProjectLocalLocation>(this.baseUrl, `${projectPath(projectId)}/local-location`);
    if (payload.scope !== "device_local_response" || payload.device_paths_exposed !== true) {
      throw new HostConnectionError("项目定位返回了非 device-local 契约");
    }
    return payload;
  }

  async inspectPackage(path: string): Promise<ProjectPackageInspection> {
    const response = await requestJson<{ contract: string; package: ProjectPackageInspection }>(
      this.baseUrl,
      "/api/v1/project-packages/inspect",
      { method: "POST", body: JSON.stringify({ path: localPath(path, "检查项目") }) },
    );
    if (response.package.scope !== "device_local_response" || response.package.device_path_exposed !== true) {
      throw new HostConnectionError("项目包检查返回了非 device-local 契约");
    }
    return response.package;
  }

  async importPackage(path: string): Promise<ProjectImportSubmission> {
    const response = await requestJson<ProjectImportSubmission>(
      this.baseUrl,
      "/api/v1/project-packages/import",
      { method: "POST", body: JSON.stringify({ path: localPath(path, "导入项目") }) },
    );
    if (response.package.scope !== "device_local_response" || response.package.device_path_exposed !== true) {
      throw new HostConnectionError("项目导入返回了非 device-local 契约");
    }
    return response;
  }

  saveProjectAs(
    projectId: string,
    destination: string,
    options: { name?: string; projectId?: string; includeCache?: boolean } = {},
  ): Promise<ProjectTransferSubmission> {
    return requestJson(this.baseUrl, `${projectPath(projectId)}/save-as`, {
      method: "POST",
      body: JSON.stringify({
        destination: localPath(destination, "另存项目"),
        name: options.name?.trim() || undefined,
        project_id: options.projectId?.trim() || undefined,
        include_cache: Boolean(options.includeCache),
      }),
    });
  }

  collectProject(
    projectId: string,
    destination: string,
    options: { includeCache?: boolean; includeMedia?: boolean } = {},
  ): Promise<ProjectTransferSubmission> {
    return requestJson(this.baseUrl, `${projectPath(projectId)}/collect`, {
      method: "POST",
      body: JSON.stringify({
        destination: localPath(destination, "收集项目"),
        include_cache: Boolean(options.includeCache),
        include_media: Boolean(options.includeMedia),
      }),
    });
  }
}
