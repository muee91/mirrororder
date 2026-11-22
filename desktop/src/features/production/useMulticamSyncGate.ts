import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/host";
import { SyncTimelineClient, type MulticamSyncTimeline } from "../../api/syncTimeline";

const POLL_MS = 1800;

function timelineSignature(timeline: MulticamSyncTimeline): string {
  const { task, recordings, previous_master } = timeline;
  return JSON.stringify([
    timeline.contract_version, timeline.project_id, timeline.phase, timeline.ready, timeline.clip_count,
    timeline.duration_seconds, timeline.offset_revision ?? 0, timeline.message,
    task?.task_id, task?.status, task?.stage, task?.updated_at, task?.progress,
    task?.message, task?.error, task?.cancel_requested, task?.created_at, task?.started_at, task?.completed_at,
    recordings?.placements?.length, recordings?.candidate_count, recordings?.unplaced_count,
    recordings?.invalid_count, timeline.timebase, timeline.cameras,
    timeline.tracks.map(track => [track.track_id, track.camera, track.label, track.clip_count]),
    previous_master?.timeline.task?.task_id, previous_master?.read_at_ms,
  ]);
}

// The Host can resolve a media binding or reread a positions file without changing
// the sync task or offset revision. On equal summaries, compare the flat media
// records in place to avoid retaining an old clip route or serializing the master.
function sameRows<T extends object>(a: readonly T[], b: readonly T[]): boolean {
  return a === b || (a.length === b.length && a.every((row, index) => {
    const other = b[index];
    for (const key in row) if (row[key] !== other[key]) return false;
    for (const key in other) if (!(key in row)) return false;
    return true;
  }));
}

function sameTimeline(a: MulticamSyncTimeline, b: MulticamSyncTimeline): boolean {
  return timelineSignature(a) === timelineSignature(b)
    && a.tracks.every((track, i) => sameRows(track.clips, b.tracks[i].clips))
    && sameRows(a.recordings?.placements ?? [], b.recordings?.placements ?? [])
    && sameRows(a.review_gaps ?? [], b.review_gaps ?? []);
}

function initialTimeline(projectId: string, inputKind: string): MulticamSyncTimeline {
  const raw = inputKind === "media-directory";
  return {
    contract_version: "multicam_sync_timeline.v1",
    project_id: projectId,
    phase: raw ? "loading" : "not-required",
    ready: !raw,
    message: raw ? "正在读取同步状态…" : "当前项目不需要多机位同步。",
    task: null,
    tracks: [],
    cameras: [],
    clip_count: 0,
    duration_seconds: 0,
  };
}

interface SyncState {
  scope: string;
  timeline: MulticamSyncTimeline;
  snapshot: { timeline: MulticamSyncTimeline; readAt: number } | null;
  readError: string;
}

export function useMulticamSyncGate(baseUrl: string, projectId: string, inputKind: string) {
  const scope = JSON.stringify([baseUrl, projectId, inputKind]);
  const [state, setState] = useState<SyncState>(() => ({
    scope, timeline: initialTimeline(projectId, inputKind), snapshot: null, readError: "",
  }));
  const requestId = useRef(0);
  const lastFetchedAtRef = useRef(0);
  const stateRef = useRef(state);

  const publishState = useCallback((next: SyncState) => {
    stateRef.current = next;
    setState(next);
  }, []);

  const refreshSyncTimeline = useCallback(async (force = false) => {
    if (inputKind !== "media-directory") return;
    const request = ++requestId.current;
    try {
      const timeline = await new SyncTimelineClient(baseUrl).read(projectId);
      if (timeline.project_id !== projectId) throw new Error("同步状态属于另一个项目");
      if (request !== requestId.current) return;
      const readAt = Date.now();
      lastFetchedAtRef.current = readAt;
      const current = stateRef.current;
      if (!force && current.scope === scope && !current.readError
          && sameTimeline(current.timeline, timeline)) return;
      const archived = timeline.previous_master;
      const saved = archived?.timeline.ready && archived.timeline.project_id === projectId
        ? { timeline: archived.timeline, readAt: archived.read_at_ms } : null;
      publishState({
        scope, timeline, readError: "",
        snapshot: timeline.ready ? { timeline, readAt } : saved ?? (current.scope === scope ? current.snapshot : null),
      });
    } catch (error) {
      if (request !== requestId.current) return;
      const current = stateRef.current;
      const readError = errorMessage(error);
      if (current.scope === scope && current.readError !== readError) publishState({ ...current, readError });
    }
  }, [baseUrl, inputKind, projectId, publishState, scope]);

  useEffect(() => {
    lastFetchedAtRef.current = 0;
    if (stateRef.current.scope !== scope) {
      publishState({ scope, timeline: initialTimeline(projectId, inputKind), snapshot: null, readError: "" });
    }
    void refreshSyncTimeline();
    return () => { requestId.current += 1; };
  }, [inputKind, projectId, publishState, refreshSyncTimeline, scope]);

  useEffect(() => {
    if (inputKind !== "media-directory") return;
    const refreshOnFocus = () => {
      // Returning to the app is an explicit request for current task state.
      // Do not suppress it just because the previous read was recent: a host
      // may have gone offline while the window was inactive.
      void refreshSyncTimeline();
    };
    globalThis.addEventListener("focus", refreshOnFocus);
    return () => globalThis.removeEventListener("focus", refreshOnFocus);
  }, [inputKind, refreshSyncTimeline, scope]);

  const current = state.scope === scope ? state : null;
  const timeline = current?.timeline ?? initialTimeline(projectId, inputKind);
  const readError = current?.readError ?? "";
  const poll = inputKind === "media-directory" && (!timeline.ready || Boolean(readError));

  useEffect(() => {
    if (!poll) return;
    const timer = globalThis.setInterval(() => void refreshSyncTimeline(), POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [poll, refreshSyncTimeline]);

  const syncTimeline: MulticamSyncTimeline = readError
    ? { ...timeline, phase: "unavailable", message: readError }
    : timeline;
  return { syncTimeline, snapshot: current?.snapshot ?? null, readError, refreshSyncTimeline };
}
