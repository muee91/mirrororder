import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useEffect, useRef, useState } from "react";
import { errorMessage, HostConnectionError } from "../api/host";
import { ProjectActionClient, type ProjectPackageInspection } from "../api/projectActions";
import { DeviceTaskClient } from "../api/tasks";

interface OpenRequest { id: number; path: string }
interface Destination {
  id: string;
  name: string;
  baseUrl: string;
  projects: ReadonlyArray<{ project_id: string }>;
}
interface Props {
  destination: Destination | null;
  signal?: AbortSignal;
  onOpen: (projectId: string) => Promise<void>;
  onNotice: (message: string) => void;
}

export function FinderProjectOpen({ destination, signal, onOpen, onNotice }: Props) {
  const [request, setRequest] = useState<OpenRequest | null>(null);
  const [inspection, setInspection] = useState<{ requestId: number; workspaceId: string; package: ProjectPackageInspection } | null>(null);
  const [problem, setProblem] = useState("");
  const [phase, setPhase] = useState<"idle" | "inspecting" | "submitting" | "opening">("idle");
  const [uncertain, setUncertain] = useState(false);
  const [retry, setRetry] = useState(0);
  const [accepted, setAccepted] = useState<{ requestId: number; projectId: string; taskId: string; destination: Destination } | null>(null);
  const read = useRef<(() => Promise<void>) | null>(null);
  const live = useRef({ destination, signal, onOpen, onNotice });
  live.current = { destination, signal, onOpen, onNotice };

  useEffect(() => {
    if (!isTauri()) return;
    let closed = false;
    let unlisten: (() => void) | undefined;
    let revision = 0;
    async function sync() {
      const current = ++revision;
      try {
        const next = await invoke<OpenRequest | null>("peek_document_open");
        if (!closed && current === revision) setRequest(next);
      } catch (error) {
        if (!closed && current === revision) live.current.onNotice(errorMessage(error));
      }
    }
    read.current = sync;
    // Subscribe first, then read the backlog. There is no gap if Finder
    // sends a document while the WebView is initializing the listener.
    void listen("mirrororder-document-open", () => void sync()).then(stop => {
      if (closed) stop();
      else unlisten = stop;
    }).catch(() => {}).finally(() => {
      if (!closed) void sync();
    });
    return () => { closed = true; read.current = null; unlisten?.(); };
  }, []);

  const requestId = request?.id;
  const path = request?.path;
  const hostUrl = destination?.baseUrl;
  const workspaceId = destination?.id;
  useEffect(() => {
    if (requestId === undefined || !path || !hostUrl || !workspaceId || signal?.aborted || accepted) return;
    let closed = false;
    setInspection(null);
    setProblem("");
    setPhase("inspecting");
    void new ProjectActionClient(hostUrl).inspectPackage(path).then(result => {
      if (!closed && !signal?.aborted) setInspection({ requestId, workspaceId, package: result });
    }).catch(error => {
      if (!closed && !signal?.aborted) setProblem(errorMessage(error));
    }).finally(() => {
      if (!closed && !signal?.aborted) setPhase("idle");
    });
    return () => { closed = true; };
  }, [accepted, hostUrl, path, requestId, retry, signal, workspaceId]);

  async function dismiss(id: number) {
    await invoke("finish_document_open", { id });
    setRequest(null);
    setAcceptanceState();
    await read.current?.();
  }

  function setAcceptanceState() {
    setAccepted(null);
    setUncertain(false);
    setInspection(null);
    setProblem("");
    setPhase("idle");
  }

  async function finishAccepted(item: NonNullable<typeof accepted>) {
    const atStart = live.current;
    if (atStart.destination?.id !== item.destination.id || atStart.signal?.aborted) {
      await dismiss(item.requestId);
      live.current.onNotice("工程已提交到原工作区；返回该工作区后可在状态中心查看。");
      return;
    }
    const tasks = new DeviceTaskClient(item.destination.baseUrl);
    for (let index = 0; index < 120; ++index) {
      if (atStart.signal?.aborted || live.current.destination?.id !== item.destination.id) {
        await dismiss(item.requestId);
        live.current.onNotice("工程已提交到原工作区；返回该工作区后可在状态中心查看。");
        return;
      }
      const task = (await tasks.list()).find(row => row.task_id === item.taskId);
      if (task?.status === "completed") {
        if (!atStart.signal?.aborted && live.current.destination?.id === item.destination.id) {
          await live.current.onOpen(item.projectId);
        }
        await dismiss(item.requestId);
        return;
      }
      if (task && ["failed", "cancelled", "interrupted"].includes(task.status)) {
        throw new Error(task.error || task.message || "导入未完成；请到状态中心查看任务或重试。");
      }
      await new Promise(resolve => globalThis.setTimeout(resolve, 750));
    }
    await dismiss(item.requestId);
    live.current.onNotice("工程正在后台导入；完成前可到状态中心查看进度。");
  }

  const ready = inspection?.requestId === requestId && inspection?.workspaceId === workspaceId ? inspection?.package : undefined;
  const duplicate = Boolean(ready && destination?.projects.some(project => project.project_id === ready.project_id));
  const busy = phase === "submitting" || phase === "opening";
  async function confirm() {
    if (!request || busy || uncertain || !destination || signal?.aborted) return;
    const current = live.current;
    if (current.signal !== signal || current.destination?.id !== destination.id) return;
    setProblem("");
    let submitting = false;
    try {
      if (accepted) {
        setPhase("opening");
        await finishAccepted(accepted);
      } else if (ready && duplicate) {
        setPhase("opening");
        await current.onOpen(ready.project_id);
        await dismiss(request.id);
      } else if (ready) {
        setPhase("submitting");
        submitting = true;
        const submitted = await new ProjectActionClient(destination.baseUrl).importPackage(request.path, {
          expectedWorkspaceId: destination.id,
          expectedProjectId: ready.project_id,
        });
        const taskId = String(submitted.task.task_id || "").trim();
        if (!taskId) throw new Error("尚未收到后台任务编号；请先在状态中心检查是否已提交，再重试。");
        const item = { requestId: request.id, projectId: submitted.package.project_id, taskId, destination };
        submitting = false;
        setAccepted(item);
        setPhase("opening");
        await finishAccepted(item);
      }
    } catch (error) {
      if (submitting && (!(error instanceof HostConnectionError) || error.status === undefined || error.status >= 500)) {
        setUncertain(true);
        setProblem(`${errorMessage(error)}。未能确认任务是否已提交，请到状态中心核对；为避免重复导入，本请求不会重发。`);
      } else {
        if (submitting) setInspection(null);
        setProblem(errorMessage(error));
      }
    } finally {
      setPhase("idle");
    }
  }

  if (!request) return null;
  const name = request.path.split("/").filter(Boolean).at(-1);
  const inWorkspace = destination !== null && !signal?.aborted;
  return (
    <section className="finder-project-open" aria-label="从 Finder 打开镜序工程">
      <div>
        <strong>{ready?.name || name}</strong>
        <p>{!inWorkspace ? "先打开或恢复一个工作区，再继续打开此工程。"
          : duplicate ? `「${destination?.name}」已存在同编号的工程；不会导入或覆盖。可明确打开工作区里的版本。`
          : `打开后会把可编辑工程导入「${destination?.name}」，不移动原目录或原片。`}</p>
        {phase === "inspecting" && <p role="status">正在验证工程…</p>}
        {busy && <p role="status">{phase === "submitting" ? "正在提交导入…" : "正在打开工程…"}</p>}
        {problem && <p role="alert">{problem}</p>}
      </div>
      <div className="finder-project-open-actions">
        <button type="button" className="secondary" disabled={busy}
          onClick={() => void dismiss(request.id).catch(error => setProblem(errorMessage(error)))}>{accepted || uncertain ? "关闭" : "取消"}</button>
        {problem && !accepted && !ready && !uncertain && inWorkspace && <button type="button" onClick={() => setRetry(value => value + 1)}>重新检查</button>}
        {(ready || accepted) && inWorkspace && !uncertain && <button type="button" disabled={busy} onClick={() => void confirm()}>
          {accepted ? "查看导入状态" : duplicate ? "打开已有工程" : "导入并打开"}
        </button>}
      </div>
    </section>
  );
}
