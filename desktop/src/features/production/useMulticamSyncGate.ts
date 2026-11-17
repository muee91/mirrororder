import { useCallback, useEffect, useRef, useState } from "react";
import { SyncTimelineClient, type MulticamSyncPhase, type MulticamSyncTimeline } from "../../api/syncTimeline";

const POLL_MS = 1800;

function initialState(inputKind: string): MulticamSyncTimeline {
  const required = inputKind === "media-directory";
  return {
    contract_version: "multicam_sync_timeline.v1",
    project_id: "",
    phase: required ? "loading" : "not-required",
    ready: !required,
    message: required ? "正在确认多机位同步状态…" : "当前项目不需要多机位同步。",
    task: null,
    tracks: [],
    cameras: [],
    clip_count: 0,
    duration_seconds: 0,
  };
}

export function useMulticamSyncGate(baseUrl: string, projectId: string, inputKind: string): {
  syncTimeline: MulticamSyncTimeline;
  syncPhase: MulticamSyncPhase;
  refreshSyncTimeline: () => Promise<void>;
  beginSyncTracking: () => void;
} {
  const [syncTimeline, setSyncTimeline] = useState<MulticamSyncTimeline>(() => initialState(inputKind));
  const requestId = useRef(0);
  const refreshSyncTimeline = useCallback(async () => {
    if (inputKind !== "media-directory") {
      setSyncTimeline(initialState(inputKind));
      return;
    }
    const currentRequest = ++requestId.current;
    try {
      const next = await new SyncTimelineClient(baseUrl).read(projectId);
      if (currentRequest === requestId.current) setSyncTimeline(next);
    } catch (error) {
      if (currentRequest !== requestId.current) return;
      setSyncTimeline({
        ...initialState(inputKind),
        project_id: projectId,
        phase: "unavailable",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }, [baseUrl, inputKind, projectId]);

  const beginSyncTracking = useCallback(() => {
    if (inputKind !== "media-directory") return;
    setSyncTimeline((current) => ({
      ...current,
      project_id: projectId,
      phase: "running",
      ready: false,
      message: "正在提交多机位同步任务…",
      tracks: [],
    }));
  }, [inputKind, projectId]);

  useEffect(() => {
    requestId.current += 1;
    setSyncTimeline({ ...initialState(inputKind), project_id: projectId });
    void refreshSyncTimeline();
  }, [baseUrl, inputKind, projectId, refreshSyncTimeline]);

  useEffect(() => {
    if (inputKind !== "media-directory" || syncTimeline.ready) return undefined;
    const timer = globalThis.setInterval(() => {
      void refreshSyncTimeline();
    }, POLL_MS);
    return () => globalThis.clearInterval(timer);
  }, [inputKind, refreshSyncTimeline, syncTimeline.ready]);

  return { syncTimeline, syncPhase: syncTimeline.phase, refreshSyncTimeline, beginSyncTracking };
}
