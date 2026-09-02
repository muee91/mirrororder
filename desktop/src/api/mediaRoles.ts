import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export type MediaSourceRole = "sync_camera" | "aerial" | "broll" | "gopro" | "insert" | "custom" | string;
export type MediaSyncPolicy = "auto" | "exclude" | string;

export interface MediaRole {
  media_id?: string;
  display_name?: string;
  camera_override?: string;
  source_role?: MediaSourceRole;
  role_label?: string;
  sync_policy?: MediaSyncPolicy;
  scene_id?: string;
  note?: string;
  actor?: string;
  updated_at?: string;
}

export interface MediaRoleStore {
  version: number;
  contract: string;
  revision: number;
  updated_at: string;
  media: Record<string, MediaRole>;
}

export interface MediaInventoryItem {
  media_id: string;
  /** Opaque material_index clip identity. Never a device path. */
  clip_id?: string;
  display_name: string;
  folder_label: string;
  inferred_camera: string;
  indexed: boolean;
  label: MediaRole;
}

export interface MediaInventory {
  contract: string;
  project_id: string;
  role_revision: number;
  inventory_updated_at: string;
  scan_required: boolean;
  summary: {
    files: number;
    indexed: number;
    unindexed: number;
    labeled: number;
    auxiliary: number;
  };
  items: MediaInventoryItem[];
  semantics: Record<string, boolean>;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

function base(value: string): string {
  const result = value.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(result)) throw new HostConnectionError("素材库 Host 地址无效");
  return result;
}

function route(projectId: string, suffix: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("素材库需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}/${suffix}`;
}

async function request<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const response = await transportFetch(`${baseUrl}${path}`, {
    ...init,
    method: init?.method ?? "GET",
    headers: { Accept: "application/json", ...(init?.body !== undefined ? { "Content-Type": "application/json" } : {}), ...Object.fromEntries(new Headers(init?.headers).entries()) },
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

export class MediaRoleClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = base(baseUrl);
  }

  inventory(projectId: string): Promise<MediaInventory> {
    return request<MediaInventory>(this.baseUrl, route(projectId, "media-inventory"));
  }

  roles(projectId: string): Promise<MediaRoleStore> {
    return request<MediaRoleStore>(this.baseUrl, route(projectId, "media-roles"));
  }

  save(
    projectId: string,
    write: { expectedRevision: number; actor: string; mediaId: string; entry: MediaRole },
  ): Promise<MediaRoleStore> {
    const mediaId = write.mediaId.trim();
    const actor = write.actor.trim();
    if (!mediaId) throw new HostConnectionError("素材角色写入需要 media_id");
    if (!actor) throw new HostConnectionError("素材角色写入需要操作者昵称");
    if (!Number.isInteger(write.expectedRevision) || write.expectedRevision < 0) throw new HostConnectionError("素材角色写入需要有效 expected_revision");
    return request<MediaRoleStore>(this.baseUrl, route(projectId, "media-roles"), {
      method: "POST",
      body: JSON.stringify({
        expected_revision: write.expectedRevision,
        actor: actor.slice(0, 80),
        changes: [{ media_id: mediaId, entry: write.entry }],
      }),
    });
  }
}
