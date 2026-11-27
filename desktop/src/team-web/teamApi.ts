import type { ReviewModelPayload } from "../api/host";
import type { SlateBoard } from "../api/production";
import type { EditorialGroupProjection, EditorialState, EditorialStorePayload } from "../api/planning";
import type { SpeechEvidence } from "../api/speechEvidence";

export interface TeamPairingStatus {
  required: boolean;
  paired: boolean;
  session_ttl_seconds?: number;
}

export interface TeamWorkspaceSummary {
  workspace_id: string;
  workspace: string;
  projects: TeamProjectSummary[];
}

export interface TeamProjectSummary {
  project_id: string;
  name?: string;
  project?: string;
  stats?: {
    groups?: number;
    clips?: number;
  };
}

export interface TeamUserMe {
  user_id: string;
  nickname: string;
  role: "viewer" | "reviewer" | "manager" | string;
  capabilities: string[];
  status: "active" | "disabled" | string;
}

export interface TeamProjectState {
  analysis_revision?: string;
  review_revision?: number;
  editorial_revision?: number;
  script_supervisor_revision?: number;
}

export interface TeamEditorialResponse {
  editorial: EditorialStorePayload;
  group: EditorialGroupProjection;
}

export class TeamApiError extends Error {
  readonly status: number;

  constructor(message: string, status = 0) {
    super(message);
    this.name = "TeamApiError";
    this.status = status;
  }
}

function randomId(prefix: string): string {
  try {
    if (globalThis.crypto?.randomUUID) return `${prefix}-${globalThis.crypto.randomUUID()}`;
  } catch {
    // Fallback below.
  }
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

export function getBrowserDeviceId(): string {
  const key = "mirrororder-browser-device-id";
  try {
    const existing = globalThis.localStorage?.getItem(key) || "";
    if (/^[A-Za-z0-9._-]{12,120}$/.test(existing)) return existing;
    const created = randomId("web");
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return randomId("web");
  }
}

export function getStableReviewerId(): string {
  const key = "mirrororder-reviewer-id";
  try {
    const existing = globalThis.localStorage?.getItem(key) || "";
    if (existing) return existing;
    const created = randomId("rev");
    globalThis.localStorage?.setItem(key, created);
    return created;
  } catch {
    return randomId("rev");
  }
}

async function requestJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("Accept", "application/json");
  headers.set("X-MirrorOrder-Device", getBrowserDeviceId());
  if (init?.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    let message = `请求失败 (${response.status})`;
    try {
      const payload = (await response.json()) as { error?: string };
      if (payload?.error) message = payload.error;
    } catch {
      // Keep HTTP fallback.
    }
    throw new TeamApiError(message, response.status);
  }
  return (await response.json()) as T;
}

export function workspacePath(workspaceId: string, suffix = ""): string {
  return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}${suffix}`;
}

export function projectPath(workspaceId: string, projectId: string, suffix = ""): string {
  return `${workspacePath(workspaceId, "/projects")}/${encodeURIComponent(projectId)}${suffix}`;
}

export function teamMediaUrl(workspaceId: string, projectId: string, clipId: string): string {
  return projectPath(workspaceId, projectId, `/media/${encodeURIComponent(clipId)}`);
}

export const teamApi = {
  getPairingStatus(): Promise<TeamPairingStatus> {
    return requestJson<TeamPairingStatus>("/api/v1/pairing");
  },

  submitPairing(code: string): Promise<{ paired: boolean }> {
    return requestJson<{ paired: boolean }>("/api/v1/pairing", {
      method: "POST",
      body: JSON.stringify({ code: code.trim() }),
    });
  },

  listWorkspaces(): Promise<{ workspaces: TeamWorkspaceSummary[] }> {
    return requestJson<{ workspaces: TeamWorkspaceSummary[] }>("/api/v1/workspaces");
  },

  getWorkspace(workspaceId: string): Promise<TeamWorkspaceSummary> {
    return requestJson<TeamWorkspaceSummary>(workspacePath(workspaceId));
  },

  getMe(workspaceId: string): Promise<{ user: TeamUserMe }> {
    return requestJson<{ user: TeamUserMe }>(workspacePath(workspaceId, "/users/me"));
  },

  saveNickname(workspaceId: string, nickname: string): Promise<{ user: TeamUserMe }> {
    return requestJson<{ user: TeamUserMe }>(workspacePath(workspaceId, "/users/me"), {
      method: "POST",
      body: JSON.stringify({ nickname: nickname.trim().slice(0, 40) }),
    });
  },

  getReviewModel(workspaceId: string, projectId: string): Promise<ReviewModelPayload> {
    return requestJson<ReviewModelPayload>(projectPath(workspaceId, projectId, "/review-model"));
  },

  getState(workspaceId: string, projectId: string): Promise<TeamProjectState> {
    return requestJson<TeamProjectState>(projectPath(workspaceId, projectId, "/state"));
  },

  getSlateBoard(workspaceId: string, projectId: string): Promise<SlateBoard> {
    return requestJson<SlateBoard>(projectPath(workspaceId, projectId, "/script-supervisor"));
  },

  getSpeechEvidence(workspaceId: string, projectId: string, clipId: string): Promise<SpeechEvidence> {
    return requestJson<SpeechEvidence>(
      projectPath(workspaceId, projectId, `/speech-evidence?clip_id=${encodeURIComponent(clipId)}`),
    );
  },

  submitOpinion(
    workspaceId: string,
    projectId: string,
    input: {
      targetKind: "group" | "assignment";
      groupId: string;
      segmentId?: string;
      state: EditorialState;
      actor: string;
      note?: string;
      clipId?: string;
      camera?: string;
      sourceTime?: number | null;
    },
  ): Promise<TeamEditorialResponse> {
    return requestJson<TeamEditorialResponse>(projectPath(workspaceId, projectId, "/opinions"), {
      method: "POST",
      body: JSON.stringify({
        target_kind: input.targetKind,
        group_id: input.groupId,
        ...(input.segmentId ? { segment_id: input.segmentId } : {}),
        state: input.state,
        actor: input.actor,
        reviewer_id: getStableReviewerId(),
        note: input.note ?? "",
        clip_id: input.clipId ?? "",
        camera: input.camera ?? "",
        source_time: input.sourceTime ?? null,
      }),
    });
  },

  addComment(
    workspaceId: string,
    projectId: string,
    input: {
      groupId: string;
      segmentId?: string;
      clipId?: string;
      camera?: string;
      sourceTime?: number | null;
      text: string;
      actor: string;
    },
  ): Promise<TeamEditorialResponse> {
    return requestJson<TeamEditorialResponse>(projectPath(workspaceId, projectId, "/comments"), {
      method: "POST",
      body: JSON.stringify({
        action: "add",
        group_id: input.groupId,
        segment_id: input.segmentId ?? "",
        clip_id: input.clipId ?? "",
        camera: input.camera ?? "",
        source_time: input.sourceTime ?? null,
        text: input.text,
        actor: input.actor,
        reviewer_id: getStableReviewerId(),
      }),
    });
  },

  deleteComment(
    workspaceId: string,
    projectId: string,
    input: { groupId: string; commentId: string; actor: string },
  ): Promise<TeamEditorialResponse> {
    return requestJson<TeamEditorialResponse>(projectPath(workspaceId, projectId, "/comments"), {
      method: "POST",
      body: JSON.stringify({
        action: "delete",
        group_id: input.groupId,
        comment_id: input.commentId,
        actor: input.actor,
        reviewer_id: getStableReviewerId(),
      }),
    });
  },
};
