import { useCallback, useEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/host";
import { SyncTimelineClient, type MulticamSyncTimeline } from "../../api/syncTimeline";

const POLL_MS = 1800;

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

  const refreshSyncTimeline = useCallback(async () => {
    if (inputKind !== "media-directory") return;
    const request = ++requestId.current;
    try {
      const timeline = await new SyncTimelineClient(baseUrl).read(projectId);
      if (timeline.project_id !== projectId) throw new Error("同步状态属于另一个项目");
      if (request !== requestId.current) return;
      const readAt = Date.now();
      const archived = timeline.previous_master;
      const saved = archived?.timeline.ready && archived.timeline.project_id === projectId
        ? { timeline: archived.timeline, readAt: archived.read_at_ms } : null;
      setState((current) => ({
        scope, timeline, readError: "",
        snapshot: timeline.ready ? { timeline, readAt } : saved ?? (current.scope === scope ? current.snapshot : null),
      }));
    } catch (error) {
      if (request !== requestId.current) return;
      setState((current) => current.scope === scope ? { ...current, readError: errorMessage(error) } : current);
    }
  }, [baseUrl, inputKind, projectId, scope]);

  useEffect(() => {
    setState({ scope, timeline: initialTimeline(projectId, inputKind), snapshot: null, readError: "" });
    void refreshSyncTimeline();
    return () => { requestId.current += 1; };
  }, [inputKind, projectId, refreshSyncTimeline, scope]);

  useEffect(() => {
    if (inputKind !== "media-directory") return;
    const refreshOnFocus = () => void refreshSyncTimeline();
    globalThis.addEventListener("focus", refreshOnFocus);
    return () => globalThis.removeEventListener("focus", refreshOnFocus);
  }, [inputKind, refreshSyncTimeline]);

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
