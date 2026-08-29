import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";
import type { SlateBoard, SlateRecord } from "./production";

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

function projectRoute(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("场记记录写入需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}/script-supervisor`;
}

async function request(baseUrl: string, projectId: string, body: Record<string, unknown>): Promise<SlateBoard> {
  const response = await transportFetch(`${baseUrl.replace(/\/+$/, "")}${projectRoute(projectId)}`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json" },
    body: JSON.stringify(body),
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
  return await response.json() as SlateBoard;
}

export class SlateRecordClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    const value = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("场记记录 Host 地址无效");
    this.baseUrl = value;
  }

  upsert(
    projectId: string,
    write: {
      recordId: string;
      expectedRevision: number;
      actor: string;
      record: Partial<SlateRecord>;
    },
  ): Promise<SlateBoard> {
    const actor = write.actor.trim();
    if (!actor) throw new HostConnectionError("场记写入需要操作者昵称");
    if (!Number.isInteger(write.expectedRevision) || write.expectedRevision < 0) {
      throw new HostConnectionError("场记写入需要有效 expected_revision");
    }
    return request(this.baseUrl, projectId, {
      action: "upsert_record",
      record_id: write.recordId.trim(),
      expected_revision: write.expectedRevision,
      actor: actor.slice(0, 80),
      record: write.record,
    });
  }

  delete(
    projectId: string,
    write: { recordId: string; expectedRevision: number; actor: string },
  ): Promise<SlateBoard> {
    const recordId = write.recordId.trim();
    const actor = write.actor.trim();
    if (!recordId) throw new HostConnectionError("删除场记需要 record_id");
    if (!actor) throw new HostConnectionError("删除场记需要操作者昵称");
    if (!Number.isInteger(write.expectedRevision) || write.expectedRevision < 0) {
      throw new HostConnectionError("删除场记需要有效 expected_revision");
    }
    return request(this.baseUrl, projectId, {
      action: "delete_record",
      record_id: recordId,
      expected_revision: write.expectedRevision,
      actor: actor.slice(0, 80),
      delete: true,
    });
  }
}
