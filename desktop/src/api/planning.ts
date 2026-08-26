import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export type EditorialState = "unreviewed" | "keep" | "best" | "reject";

export interface EditorialTarget {
  kind: "group" | "assignment" | string;
  group_id: string;
  segment_id: string;
}

export interface EditorialOpinion {
  state: EditorialState | string;
  actor: string;
  reviewer_id?: string;
  updated_at: string;
}

export interface EditorialDecision {
  target: EditorialTarget;
  state: EditorialState | string;
  actor: string;
  updated_at: string;
}

export interface EditorialOpinionBucket {
  target: EditorialTarget;
  reviewers: Record<string, EditorialOpinion>;
}

export interface EditorialStorePayload {
  version: number;
  revision: number;
  updated_at: string;
  opinions: Record<string, EditorialOpinionBucket>;
  decisions: Record<string, EditorialDecision>;
}

export interface EditorialGroupProjection {
  revision: number;
  opinions: {
    group: Array<EditorialOpinion & { target: EditorialTarget }>;
    assignments: Array<EditorialOpinion & { target: EditorialTarget }>;
  };
  decision: {
    group: EditorialDecision | null;
    assignments: EditorialDecision[];
  };
}

export interface EditorialWriteResponse {
  editorial: EditorialStorePayload;
  group: EditorialGroupProjection;
}

export interface CoverageIssue {
  code: string;
  severity: string;
  label?: string;
  detail?: string;
}

export interface CoverageAngle {
  clip_id: string;
  media_id: string;
  camera: string;
  name: string;
  duration: number;
  source_start: number;
  source_end: number | null;
  shot_type: string;
  shot_source: string;
  supervisor_note: string;
  coverage_role: string;
  visible_people: string[];
  technical_issues: string[];
}

export interface CoverageTakeGroup {
  group_id: string;
  start: number;
  end: number;
  duration: number;
  mapping_source: string;
  mapping_status: string;
  script_segment_ids: string[];
  audit: {
    visual_current?: boolean;
    mapping_current?: boolean;
    mapping_stale?: boolean;
  };
  angles: CoverageAngle[];
  script_supervisor: Record<string, unknown>;
  rough_cut: {
    technical_usability?: string;
    take_completeness?: string;
    coverage_role?: string;
    continuity_risk?: string;
  };
  continuity_issues: CoverageIssue[];
  editorial_decision: {
    state?: string;
    source?: string;
    group?: Record<string, unknown>;
    assignments?: Array<Record<string, unknown>>;
  };
}

export interface CoverageScene {
  scene_id: string;
  episode: number;
  heading: string;
  script_segment_ids: string[];
  script_order: { start: number; end: number };
  summary: {
    take_groups: number;
    angles: number;
    known_shots: number;
    unknown_shots: number;
    coverage_roles: Record<string, number>;
    take_coverage_roles: Record<string, number>;
    shot_types: Record<string, number>;
    editorial_decisions: Record<string, number>;
    script_supervisor: Record<string, number>;
    continuity_risks: number;
  };
  issues: CoverageIssue[];
  continuity: Array<{ group_id: string; risk: string; issues: CoverageIssue[] }>;
  take_groups: CoverageTakeGroup[];
}

export interface CoverageGraph {
  contract: "coverage.v1" | string;
  revision: string;
  project_id: string;
  filters: { scene_id?: string; episode?: number };
  summary: {
    scenes: number;
    mapped_take_groups: number;
    angles: number;
    known_shots: number;
    unknown_shots: number;
    continuity_risks: number;
    unobserved_scenes: number;
    unplaced_groups: number;
    episode_only_groups: number;
    script_supervisor_groups: number;
  };
  scenes: CoverageScene[];
  episode_only_groups: Array<Record<string, unknown>>;
  unplaced_group_ids: string[];
  semantics: Record<string, boolean>;
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

export interface RoughCutSegment {
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
  issues: CoverageIssue[];
}

export interface RoughCutScene {
  scene_id: string;
  episode: number;
  heading: string;
  readiness: string;
  summary: Record<string, number>;
  segments: RoughCutSegment[];
}

export interface RoughCutPlan {
  contract: "rough_cut_plan.v1" | string;
  revision: string;
  project_id: string;
  coverage_revision: string;
  filters: Record<string, unknown>;
  readiness: string;
  summary: {
    scenes?: number;
    segments?: number;
    selection_status?: Record<string, number>;
    high_continuity_segments?: number;
    partial_without_range_segments?: number;
    [key: string]: unknown;
  };
  scenes: RoughCutScene[];
  semantics: Record<string, boolean>;
  timebase?: {
    status?: string;
    source?: string;
    numerator?: number;
    denominator?: number;
    frame_duration?: string;
    reason?: string;
  };
}

export interface AssemblyBlock {
  kind: "source" | "unresolved" | string;
  script_segment_ids: string[];
  selection_status: string;
  group_id: string;
  angle: {
    status?: string;
    clip_id?: string;
    camera?: string;
    shot_type?: string;
    coverage_role?: string;
    candidates?: Array<Record<string, unknown>>;
  };
  usable_range: {
    status?: string;
    start?: number;
    end?: number;
    duration?: number;
    issues?: CoverageIssue[];
  };
  script_supervisor?: Record<string, unknown>;
  continuity_risk?: string;
  issues: CoverageIssue[];
  assembly_status?: string;
  timeline_start?: number;
  timeline_end?: number;
  duration?: number;
}

export interface AssemblyScene {
  scene_id: string;
  episode: number;
  heading: string;
  readiness: string;
  duration: number;
  summary: {
    blocks: number;
    source_blocks: number;
    unresolved_blocks: number;
    attention: number;
    blocked: number;
  };
  blocks: AssemblyBlock[];
}

export interface AssemblyTimeline {
  contract: "assembly_timeline.v1" | string;
  revision: string;
  rough_cut_plan_revision: string;
  coverage_revision: string;
  project_id: string;
  filters: Record<string, unknown>;
  readiness: string;
  duration: number;
  summary: {
    scenes: number;
    blocks: number;
    statuses: Record<string, number>;
  };
  scenes: AssemblyScene[];
  semantics: Record<string, boolean>;
}

const REQUEST_TIMEOUT_MS = 20_000;

async function transportFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(input, init) : globalThis.fetch(input, init);
}

async function decodeError(response: Response): Promise<string> {
  try {
    const payload = await response.json() as { error?: string };
    if (payload.error) return payload.error;
  } catch {
    // Stable HTTP fallback below.
  }
  return `${response.status} ${response.statusText}`.trim();
}

function normalizeBaseUrl(baseUrl: string): string {
  const value = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(value)) throw new HostConnectionError("Production planning Host 地址无效");
  return value;
}

function projectPath(projectId: string): string {
  const value = projectId.trim();
  if (!value) throw new HostConnectionError("Production planning 需要 project_id");
  return `/api/v1/projects/${encodeURIComponent(value)}`;
}

function planningQuery(filter?: { episode?: number | null; sceneId?: string | null }): string {
  const query = new URLSearchParams();
  if (filter?.episode && Number.isInteger(filter.episode) && filter.episode > 0) query.set("episode", String(filter.episode));
  if (filter?.sceneId?.trim()) query.set("scene_id", filter.sceneId.trim());
  return query.size ? `?${query.toString()}` : "";
}

async function requestJson<T>(baseUrl: string, path: string, init?: RequestInit): Promise<T> {
  const controller = new AbortController();
  const timeout = globalThis.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  if (init?.body !== undefined) headers.set("Content-Type", "application/json");
  try {
    const response = await transportFetch(`${baseUrl}${path}`, { ...init, method: init?.method ?? "GET", headers, signal: controller.signal });
    if (!response.ok) throw new HostConnectionError(await decodeError(response), { status: response.status });
    return await response.json() as T;
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new HostConnectionError(`Production planning 请求失败：${message}`, { cause: error });
  } finally {
    globalThis.clearTimeout(timeout);
  }
}

export class PlanningClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  coverage(projectId: string, filter?: { episode?: number | null; sceneId?: string | null }): Promise<CoverageGraph> {
    return requestJson<CoverageGraph>(this.baseUrl, `${projectPath(projectId)}/coverage${planningQuery(filter)}`);
  }

  roughCut(projectId: string, filter?: { episode?: number | null; sceneId?: string | null }): Promise<RoughCutPlan> {
    return requestJson<RoughCutPlan>(this.baseUrl, `${projectPath(projectId)}/rough-cut-plan${planningQuery(filter)}`);
  }

  assembly(projectId: string, filter?: { episode?: number | null; sceneId?: string | null }): Promise<AssemblyTimeline> {
    return requestJson<AssemblyTimeline>(this.baseUrl, `${projectPath(projectId)}/assembly-timeline${planningQuery(filter)}`);
  }
}

export class EditorialClient {
  readonly baseUrl: string;

  constructor(baseUrl: string) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
  }

  status(projectId: string): Promise<EditorialStorePayload> {
    return requestJson<EditorialStorePayload>(this.baseUrl, `${projectPath(projectId)}/editorial`);
  }

  decision(
    projectId: string,
    write: {
      targetKind: "group" | "assignment";
      groupId: string;
      segmentId?: string;
      state: EditorialState;
      actor: string;
      expectedRevision: number;
    },
  ): Promise<EditorialWriteResponse> {
    const groupId = write.groupId.trim();
    const actor = write.actor.trim();
    const segmentId = write.segmentId?.trim() ?? "";
    if (!groupId) throw new HostConnectionError("最终编辑决定需要 group_id");
    if (!actor) throw new HostConnectionError("最终编辑决定需要操作者昵称");
    if (write.targetKind === "assignment" && !segmentId) throw new HostConnectionError("剧本段最终决定需要 segment_id");
    if (!Number.isInteger(write.expectedRevision) || write.expectedRevision < 0) throw new HostConnectionError("最终编辑决定需要有效 expected_revision");
    return requestJson<EditorialWriteResponse>(this.baseUrl, `${projectPath(projectId)}/editorial-decision`, {
      method: "POST",
      body: JSON.stringify({
        target_kind: write.targetKind,
        group_id: groupId,
        ...(segmentId ? { segment_id: segmentId } : {}),
        state: write.state,
        actor: actor.slice(0, 80),
        expected_revision: write.expectedRevision,
      }),
    });
  }
}
