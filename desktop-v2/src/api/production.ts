import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export type SlateStatus = "unmarked" | "usable" | "partial" | "ng";

export interface SlateUsableRange {
  start: number;
  end: number;
}

export interface SlateAngleNote {
  shot_type: string;
  note?: string;
}

export interface SlateAttachment {
  clip_id: string;
  media_id: string;
  camera: string;
  display_name: string;
  shot_type: string;
  source_role: string;
  note: string;
}

export interface SlateEntry {
  group_id: string;
  script_scene_id: string;
  episode: number | null;
  scene: string;
  shot: string;
  take_number: number | null;
  status: SlateStatus;
  note: string;
  usable_range?: SlateUsableRange;
  preferred_clip_id: string;
  angles: Record<string, SlateAngleNote>;
  actor: string;
  updated_at: string;
}

export interface SlateRecord {
  record_id: string;
  source_group_id: string;
  script_scene_id: string;
  episode: number | null;
  scene: string;
  shot: string;
  take_number: number | null;
  status: SlateStatus;
  note: string;
  usable_range?: SlateUsableRange;
  preferred_clip_id: string;
  attachments: SlateAttachment[];
  actor: string;
  updated_at: string;
}

export interface SlateBoard {
  version: number;
  contract: "script_supervisor.v2" | string;
  revision: number;
  updated_at: string;
  records: Record<string, SlateRecord>;
  entries: Record<string, SlateEntry>;
  semantics: Record<string, boolean>;
}

export interface SlateParseResult {
  episode: number | null;
  scene: string;
  shot: string;
  take_number: number | null;
  status: SlateStatus;
  note: string;
  angle_shots: Record<string, string>;
  range_hint: string;
  inherit_previous: boolean;
  parser: string;
  generic_shot?: string;
}

export interface SlateParsePayload {
  contract: string;
  input: string;
  result: SlateParseResult;
}

export interface IdentityRoleCandidate {
  role_name: string;
  confidence: number;
  score: number;
  share: number;
  supporting_takes: number;
  unambiguous_takes: number;
  human_placement_takes: number;
  source: string;
  requires_confirmation: boolean;
}

export interface IdentityOccurrence {
  group_id: string;
  clip_id: string;
  camera: string;
  start: number;
  end: number;
  source_time: number;
  confidence: number;
  transcript_text: string;
}

export interface IdentityRow {
  identity_id: string;
  kind: "face" | "speaker" | string;
  label: string;
  role_name: string;
  observation_count: number;
  take_count: number;
  average_confidence: number;
  example_group_id: string;
  confirmed: boolean;
  created_at: string;
  updated_at: string;
  example?: Record<string, unknown> | null;
  occurrences: IdentityOccurrence[];
  role_candidates?: IdentityRoleCandidate[];
  suggested_role_name?: string;
  suggested_role_confidence?: number;
  suggested_role_source?: string;
}

export interface IdentityListPayload {
  contract: string;
  project_id: string;
  kind: string;
  identities: IdentityRow[];
  semantics: Record<string, boolean>;
}

export interface AssistantItem {
  item_id?: string;
  kind?: string;
  priority?: number;
  title?: string;
  summary?: string;
  status?: string;
  [key: string]: unknown;
}

export interface AssistantStatus {
  version: number;
  contract: string;
  revision: number;
  updated_at: string;
  summary: string;
  items: AssistantItem[];
  [key: string]: unknown;
}

export interface AssistantAnswer {
  message?: string;
  answer?: string;
  text?: string;
  [key: string]: unknown;
}

export interface RoughCutAngle {
  group_id: string;
  clip_id: string;
  camera: string;
  name: string;
  shot_type: string;
  shot_source: string;
  coverage_role: string;
  supervisor_note: string;
}

export interface RoughCutCandidate {
  group_id: string;
  group_start: number;
  group_end: number;
  duration: number;
  delivery_state: string;
  decision_source: string;
  creative_authority: boolean;
  angles: RoughCutAngle[];
  continuity_risk: string;
  audit_mapping_current: boolean;
  script_supervisor: Record<string, unknown>;
  supervisor_blocked: boolean;
  supervisor_partial: boolean;
}

export interface RoughCutSegmentPlan {
  script: {
    segment_id: string;
    order: number;
    type: string;
    speaker: string;
    text: string;
  };
  selection_status: string;
  primary_group_id: string;
  candidates: RoughCutCandidate[];
  role_pools: Record<string, RoughCutAngle[]>;
  summary: Record<string, number>;
  issues: Array<Record<string, unknown>>;
}

export interface RoughCutScenePlan {
  scene_id: string;
  episode: number;
  heading: string;
  readiness: string;
  summary: Record<string, number>;
  segments: RoughCutSegmentPlan[];
}

export interface RoughCutPlan {
  contract: "rough_cut_plan.v1" | string;
  revision: string;
  project_id: string;
  coverage_revision: string;
  filters: Record<string, unknown>;
  readiness: string;
  summary: Record<string, unknown>;
  scenes: RoughCutScenePlan[];
  semantics: Record<string, boolean>;
}

export interface WaveformPayload {
  contract: "waveform.v1" | string;
  clip_id: string;
  samples: number;
  requested_samples: number;
  sample_rate: number;
  peaks: number[];
  derived: boolean;
  editorial_authority: boolean;
  source_fingerprint: string;
}

const REQUEST_TIMEOUT_MS = 10_000;
const WAVEFORM_TIMEOUT_MS = 70_000;

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function decodeError(response: Response): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // Keep stable HTTP fallback.
  }
  return `${response.status} ${response.statusText}`.trim();
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit, timeoutMs = REQUEST_TIMEOUT_MS): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), timeoutMs);
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await transportFetch(`${baseUrl}${path}`, {
      ...init,
      method: init?.method ?? "GET",
      headers,
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new HostConnectionError(await decodeError(response), { status: response.status });
    }
    return (await response.json()) as T;
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HostConnectionError(`Desktop Production API 请求失败：${message}`, { cause: error });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

function projectPath(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("Production API 需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}`;
}

function actorValue(actor: string): string {
  const value = actor.trim();
  if (!value) throw new HostConnectionError("写入人工生产事实需要操作者昵称");
  return value.slice(0, 80);
}

export class ProductionClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.trim().replace(/\/+$/, "");
    if (!/^https?:\/\//i.test(this.baseUrl)) {
      throw new HostConnectionError("Production API Host 地址无效");
    }
  }

  scriptSupervisor(projectId: string): Promise<SlateBoard> {
    return requestJson<SlateBoard>(this.baseUrl, `${projectPath(projectId)}/script-supervisor`);
  }

  parseSlate(projectId: string, text: string, previous?: Partial<SlateEntry>): Promise<SlateParsePayload> {
    const value = text.trim();
    if (!value) throw new HostConnectionError("快速场记录入不能为空");
    return requestJson<SlateParsePayload>(
      this.baseUrl,
      `${projectPath(projectId)}/script-supervisor-parse`,
      {
        method: "POST",
        body: JSON.stringify({ text: value, previous: previous ?? {}, allow_model: true }),
      },
    );
  }

  writeSlateEntry(
    projectId: string,
    write: {
      groupId: string;
      expectedRevision: number;
      actor: string;
      entry: Partial<SlateEntry>;
    },
  ): Promise<SlateBoard> {
    const groupId = write.groupId.trim();
    if (!groupId) throw new HostConnectionError("场记写入需要 group_id");
    if (!Number.isInteger(write.expectedRevision) || write.expectedRevision < 0) {
      throw new HostConnectionError("场记写入需要有效 expected_revision");
    }
    return requestJson<SlateBoard>(this.baseUrl, `${projectPath(projectId)}/script-supervisor`, {
      method: "POST",
      body: JSON.stringify({
        group_id: groupId,
        expected_revision: write.expectedRevision,
        actor: actorValue(write.actor),
        entry: write.entry,
      }),
    });
  }

  identities(projectId: string, kind: "" | "face" | "speaker" = ""): Promise<IdentityListPayload> {
    const query = kind ? `?kind=${encodeURIComponent(kind)}` : "";
    return requestJson<IdentityListPayload>(this.baseUrl, `${projectPath(projectId)}/identities${query}`);
  }

  async confirmIdentity(
    projectId: string,
    write: { identityId: string; label: string; roleName: string },
  ): Promise<IdentityRow> {
    const identityId = write.identityId.trim();
    if (!identityId) throw new HostConnectionError("确认身份需要 identity_id");
    const response = await requestJson<{ identity: IdentityRow }>(
      this.baseUrl,
      `${projectPath(projectId)}/identities`,
      {
        method: "POST",
        body: JSON.stringify({
          identity_id: identityId,
          label: write.label.trim(),
          role_name: write.roleName.trim(),
        }),
      },
    );
    return response.identity;
  }

  assistant(projectId: string): Promise<AssistantStatus> {
    return requestJson<AssistantStatus>(this.baseUrl, `${projectPath(projectId)}/assistant`);
  }

  cycleAssistant(projectId: string, forcePlan = false): Promise<AssistantStatus> {
    return requestJson<AssistantStatus>(this.baseUrl, `${projectPath(projectId)}/assistant/cycle`, {
      method: "POST",
      body: JSON.stringify({ force_plan: forcePlan }),
    });
  }

  messageAssistant(projectId: string, message: string): Promise<AssistantAnswer> {
    const value = message.trim();
    if (!value) throw new HostConnectionError("小镜消息不能为空");
    return requestJson<AssistantAnswer>(this.baseUrl, `${projectPath(projectId)}/assistant/message`, {
      method: "POST",
      body: JSON.stringify({ message: value }),
    });
  }

  roughCutPlan(projectId: string, filter?: { episode?: number; sceneId?: string }): Promise<RoughCutPlan> {
    const query = new URLSearchParams();
    if (filter?.episode && Number.isInteger(filter.episode) && filter.episode > 0) {
      query.set("episode", String(filter.episode));
    }
    if (filter?.sceneId?.trim()) query.set("scene_id", filter.sceneId.trim());
    const suffix = query.size ? `?${query.toString()}` : "";
    return requestJson<RoughCutPlan>(this.baseUrl, `${projectPath(projectId)}/rough-cut-plan${suffix}`);
  }

  waveform(projectId: string, clipId: string, samples = 512): Promise<WaveformPayload> {
    const value = clipId.trim();
    if (!value) throw new HostConnectionError("waveform 需要 clip_id");
    const boundedSamples = Math.max(64, Math.min(4096, Math.round(samples || 512)));
    return requestJson<WaveformPayload>(
      this.baseUrl,
      `${projectPath(projectId)}/waveform/${encodeURIComponent(value)}?samples=${boundedSamples}`,
      undefined,
      WAVEFORM_TIMEOUT_MS,
    );
  }
}
