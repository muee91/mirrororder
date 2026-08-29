import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export interface RoughPlacementPlan {
  take_start: number;
  take_end: number;
  episode: number;
  take_count: number;
  resolved_groups: number;
  missing_take_indices: number[];
  group_ids?: string[];
}

export interface RoughPlacementPayload {
  contract: "rough_placement.v1" | string;
  text: string;
  plans: RoughPlacementPlan[];
  resolved_groups: number;
  missing_take_indices: number[];
  requires_confirmation: boolean;
  applied: boolean;
  review_revision?: number;
}

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

export class RoughPlacementClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const value = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("粗归集 Host 地址无效");
    this.baseUrl = value;
  }

  async run(projectId: string, text: string, options: { confirm: boolean; actor?: string; expectedRevision?: number }): Promise<RoughPlacementPayload> {
    const project = projectId.trim();
    const value = text.trim();
    if (!project) throw new HostConnectionError("粗归集需要 project_id");
    if (!value) throw new HostConnectionError("粗归集内容不能为空");
    if (options.confirm && !options.actor?.trim()) throw new HostConnectionError("确认粗归集需要操作者昵称");
    const response = await transportFetch(`${this.baseUrl}/api/v1/projects/${encodeURIComponent(project)}/rough-placement`, {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/json" },
      body: JSON.stringify({
        text: value,
        confirm: options.confirm,
        actor: options.actor?.trim() || undefined,
        expected_revision: options.expectedRevision,
      }),
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
    return await response.json() as RoughPlacementPayload;
  }

  preview(projectId: string, text: string): Promise<RoughPlacementPayload> {
    return this.run(projectId, text, { confirm: false });
  }

  apply(projectId: string, text: string, actor: string, expectedRevision: number): Promise<RoughPlacementPayload> {
    return this.run(projectId, text, { confirm: true, actor, expectedRevision });
  }
}
