import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export interface SlateResolvedMediaItem {
  media_id: string;
  clip_id: string;
  camera: string;
  display_name: string;
  source_role: string;
  indexed: boolean;
}

export interface SlateResolvedMediaPayload {
  contract: "slate_media_resolve.v1" | string;
  project_id: string;
  items: SlateResolvedMediaItem[];
  errors: Array<{ name: string; error: string }>;
  semantics: {
    explicit_device_action: boolean;
    device_paths_exposed: boolean;
    shared_identity: string;
    writes_slate_record: boolean;
    editorial_authority: boolean;
  };
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

export class SlateMediaClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const value = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("场记素材 Host 地址无效");
    this.baseUrl = value;
  }

  async resolveDrop(projectId: string, paths: string[]): Promise<SlateResolvedMediaPayload> {
    const id = projectId.trim();
    const values = paths.map((value) => value.trim()).filter(Boolean).slice(0, 33);
    if (!id) throw new HostConnectionError("场记素材拖入需要 project_id");
    if (!values.length) throw new HostConnectionError("拖入素材不能为空");
    const response = await transportFetch(`${this.baseUrl}/api/v1/projects/${encodeURIComponent(id)}/slate-media-resolve`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({ paths: values }),
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
    const payload = await response.json() as SlateResolvedMediaPayload;
    if (payload.semantics?.device_paths_exposed !== false) {
      throw new HostConnectionError("场记素材解析响应违反路径隔离契约");
    }
    return payload;
  }
}
