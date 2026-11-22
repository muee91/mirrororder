import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage, type ProjectSummary } from "../../api/host";
import { DesktopClient } from "../../api/desktop";
import type { AssistantSelection } from "../../api/production";
import { ProjectTaskClient, canRetryTask } from "../../api/tasks";
import {
  listenXiaoJingVisibilityChanged, readXiaoJingWindowState, syncXiaoJingContext, toggleXiaoJingWindow,
  type XiaoJingContextSnapshot, type XiaoJingMainAction,
} from "../../api/xiaojingWindow";
import { EvidencePreview } from "./EvidencePreview";
import { evidenceLocation, type EvidenceReference } from "./evidenceLocation";
import { canonicalProductionPage, hasRememberedProjectPage, readProjectPage, rememberProjectPage, readSyncSubmissionIssue, rememberSyncSubmissionIssue, type ProductionPage } from "../../app/resumeState";
import { StudioIcon } from "../../components/StudioIcons";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { diagnosticPage } from "../assistant/assistantPresentation";
import { SemanticSearchPalette } from "../search/SemanticSearchPalette";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import { SyncTaskWorkspace } from "../editor/MulticamSyncTimeline";
import { SyncInspectionWorkbench } from "../editor/SyncInspectionWorkbench";
import { SyncDeliveryWorkspace } from "../editor/SyncDeliveryWorkspace";
import { ProjectModuleNavigation, canOpenProductionModule } from "./ProjectModuleNavigation";
import { MaterialWorkspace, type MaterialView } from "../material/MaterialWorkspace";
import type { SlateDraftSession } from "../slate/slateDraftSession";
import "../media/media.css";
import { ReviewWorkspace } from "../review/ReviewWorkspace";
import { ScriptWorkspace } from "../script/ScriptWorkspace";
import "../script/script-workspace.css";
import type {
  ProductionNavigationIntent,
  ProductionSelectionContext,
  ProductionWorkspace,
} from "./productionNavigation";
import { useMulticamSyncGate } from "./useMulticamSyncGate";
import "./production.css";
import "./assistant-drawer.css";
import "./product-experience.css";
import "./professional-project-workbench.css";
import "./production-workspaces.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  workspaceId?: string;
  slateDraftSession?: SlateDraftSession;
  active?: boolean;
  projectNavigation?: ReactNode;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  externalXiaoJingAction?: (XiaoJingMainAction & { nonce: number }) | null;
  xiaojingWorkspace?: Pick<XiaoJingContextSnapshot, "workspace_name" | "projects" | "appearance">;
  onXiaoJingError?: (message: string) => void;
  onOpenTeamReview?: () => void;
  onTaskChanged?: () => void;
  onOpenStatus?: () => void;
  onOpenSettings?: () => void;
  onPageChange?: (page: ProductionPage) => void;
  onSyncStatusChange?: (projectId: string, ready: boolean, phase: string) => void;
  showModuleRail?: boolean;
}

type ProductionArea = ProductionWorkspace;

interface AreaPageDefinition {
  page: ProductionPage;
  label: string;
}

interface AreaDefinition {
  label: string;
  defaultPage: ProductionPage;
  pages: AreaPageDefinition[];
}

type ProductionSelectionValues = {
  groupId?: string | null;
  clipId?: string | null;
  mediaId?: string | null;
  recordId?: string | null;
  sourceRange?: ProductionSelectionContext["sourceRange"];
  scriptSegmentId?: string | null;
  timelineClipId?: string | null;
};

const AREAS: Record<ProductionArea, AreaDefinition> = {
  material: {
    label: "素材",
    defaultPage: "slate",
    pages: [
      { page: "slate", label: "场记" },
      { page: "media-library", label: "素材库" },
      { page: "takes", label: "Take" },
      { page: "identity", label: "人物" },
      { page: "media-binding", label: "本机素材" },
    ],
  },
  script: {
    label: "剧本",
    defaultPage: "script",
    pages: [{ page: "script", label: "剧本" }],
  },
  timeline: {
    label: "时间线",
    defaultPage: "timeline",
    pages: [{ page: "timeline", label: "时间线" }],
  },
  review: {
    label: "审阅",
    defaultPage: "watch",
    pages: [{ page: "watch", label: "看片" }],
  },
};

const ALL_PAGES = new Set<ProductionPage>(Object.values(AREAS).flatMap((area) => area.pages.map((item) => item.page)));

function safeProductionPage(page: ProductionPage): ProductionPage {
  const canonical = canonicalProductionPage(page);
  if (canonical === "sync-task" || canonical === "sync-inspect" || canonical === "sync-delivery") return canonical;
  return ALL_PAGES.has(canonical) ? canonical : "slate";
}

function areaForPage(page: ProductionPage): ProductionArea {
  const canonical = safeProductionPage(page);
  if (canonical === "sync-task" || canonical === "sync-inspect" || canonical === "sync-delivery") return "timeline";
  for (const [key, area] of Object.entries(AREAS) as Array<[ProductionArea, AreaDefinition]>) {
    if (area.pages.some((item) => item.page === canonical)) return key;
  }
  return "material";
}

function pageLabel(page: ProductionPage): string {
  const canonical = safeProductionPage(page);
  if (canonical === "sync-task") return "同步任务";
  if (canonical === "sync-inspect") return "同步核对";
  if (canonical === "sync-delivery") return "同步工程交付";
  if (canonical === "takes") return "素材库 / Take 详情";
  if (canonical === "timeline") return "选片组接";
  for (const area of Object.values(AREAS)) {
    const item = area.pages.find((candidate) => candidate.page === canonical);
    if (item) return item.label;
  }
  return "场记";
}

function materialViewForPage(page: ProductionPage): MaterialView {
  if (page === "media-library") return "library";
  if (page === "takes") return "takes";
  if (page === "identity") return "people";
  if (page === "media-binding") return "repair";
  return "slate";
}

function pageForMaterialView(view: MaterialView): ProductionPage {
  if (view === "library") return "media-library";
  if (view === "takes") return "takes";
  if (view === "people") return "identity";
  if (view === "repair") return "media-binding";
  return "slate";
}

function normalizedContext(
  projectId: string,
  values: ProductionSelectionValues,
): ProductionSelectionContext {
  const groupId = values.groupId?.trim();
  const clipId = values.clipId?.trim();
  const scriptSegmentId = values.scriptSegmentId?.trim();
  const timelineClipId = values.timelineClipId?.trim();
  return {
    projectId,
    ...(groupId ? { groupId } : {}),
    ...(clipId ? { clipId } : {}),
    ...(values.mediaId ? { mediaId: values.mediaId } : {}),
    ...(values.recordId ? { recordId: values.recordId } : {}),
    ...(values.sourceRange ? { sourceRange: values.sourceRange } : {}),
    ...(scriptSegmentId ? { scriptSegmentId } : {}),
    ...(timelineClipId ? { timelineClipId } : {}),
  };
}

function assistantSelectionSummary(selection: AssistantSelection): string {
  const { camera, clip_id, media_id, sync_clip_id, group_id, script_segment_id } = selection;
  return [
    camera ? `${camera} 机位` : (clip_id || media_id || sync_clip_id) && "素材已选",
    group_id && "Take 已选",
    script_segment_id && "剧本段落",
  ].filter(Boolean).join(" · ");
}

export function ProjectWorkbench({
  baseUrl, project, workspaceId = baseUrl, slateDraftSession, active = true, projectNavigation,
  pageRequest = null, externalXiaoJingAction, xiaojingWorkspace, onXiaoJingError,
  onOpenTeamReview, onTaskChanged, onOpenStatus, onOpenSettings, onPageChange, onSyncStatusChange,
  showModuleRail = true,
}: Props) {
  const desktopHud = isTauri();
  const [page, setPage] = useState<ProductionPage>(() => {
    const saved = safeProductionPage(readProjectPage(project.project_id));
    if (project.input_kind === "media-directory") {
      if (!hasRememberedProjectPage(project.project_id)) return "sync-task";
    }
    return saved;
  });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [assistantWide, setAssistantWide] = useState(false);
  const [selection, setSelection] = useState<ProductionSelectionContext>(() => ({ projectId: project.project_id }));
  const [navigationIntent, setNavigationIntent] = useState<ProductionNavigationIntent | null>(null);
  const [deliveryRequestNonce, setDeliveryRequestNonce] = useState(0);
  const [returnPage, setReturnPage] = useState<ProductionPage | null>(null);
  const [evidence, setEvidence] = useState<{ selection: ProductionSelectionContext; snippet?: string } | null>(null);
  const [slateFocus, setSlateFocus] = useState<ProductionSelectionContext | null>(null);
  const [slateVisited, setSlateVisited] = useState(false);
  const [command, setCommand] = useState<"start" | "cancel" | "">("");
  const [commandError, setCommandError] = useState("");
  const [submissionIssue, setSubmissionIssue] = useState(() => readSyncSubmissionIssue(workspaceId, project.project_id));
  const commanding = useRef(false);
  const assistantToggle = useRef<HTMLButtonElement>(null);
  const assistantDraft = useMemo(() => ({ text: "", includeSelection: false }), [baseUrl, project.project_id]);
  const navigationNonce = useRef(0);
  const handledPageRequest = useRef<number | undefined>(undefined);
  const handledXiaoJingAction = useRef<number | undefined>(undefined);
  const scheduleContextSync = useRef<(() => void) | null>(null);
  const { syncTimeline, snapshot, readError, refreshSyncTimeline } = useMulticamSyncGate(baseUrl, project.project_id, project.input_kind);
  const master = syncTimeline.ready ? syncTimeline : snapshot?.timeline ?? syncTimeline;
  const syncBlocked = project.input_kind === "media-directory" && !master.ready;
  const visiblePage = syncBlocked
    && !["sync-task", "media-library", "media-binding"].includes(page) ? "sync-task" : page;

  const area = areaForPage(visiblePage);
  const currentSelection = selection.projectId === project.project_id ? selection : { projectId: project.project_id };
  const pageFocus = useMemo<{ current: AssistantSelection | null }>(() => ({ current: null }), [project.project_id, visiblePage]);
  const [focusSummary, setFocusSummary] = useState<{ pageFocus: typeof pageFocus; label: string } | null>(null);
  const inspectSelection = useCallback((next: AssistantSelection) => {
    const label = assistantSelectionSummary(next);
    if (!pageFocus.current || assistantSelectionSummary(pageFocus.current) !== label) setFocusSummary({ pageFocus, label });
    pageFocus.current = next;
    scheduleContextSync.current?.();
  }, [pageFocus]);
  const selectionContext = useMemo<AssistantSelection>(() => ({
    group_id: currentSelection.groupId, clip_id: currentSelection.clipId,
    media_id: currentSelection.mediaId, script_segment_id: currentSelection.scriptSegmentId,
  }), [currentSelection.groupId, currentSelection.clipId, currentSelection.mediaId, currentSelection.scriptSegmentId]);
  const selectionSummary = focusSummary?.pageFocus === pageFocus
    ? focusSummary.label : assistantSelectionSummary(selectionContext);
  const currentIntent = navigationIntent?.projectId === project.project_id ? navigationIntent : null;

  const updateSelection = useCallback((values: ProductionSelectionValues): void => {
    setSelection((previous) => {
      const next = normalizedContext(project.project_id, values);
      if (previous.projectId !== next.projectId || previous.clipId !== next.clipId || previous.groupId !== next.groupId) return next;
      return { ...previous, ...next };
    });
  }, [project.project_id]);

  const selectSlateRecord = useCallback((value: ProductionSelectionContext) => {
    setSelection((previous) => ({ ...value,
      sourceRange: value.sourceRange ?? (previous.recordId === value.recordId && previous.clipId === value.clipId
        && previous.mediaId === value.mediaId ? previous.sourceRange : undefined),
      scriptSegmentId: previous.groupId === value.groupId ? previous.scriptSegmentId : undefined,
    }));
  }, []);

  function openEvidence(reference: EvidenceReference) {
    setEvidence({ selection: { ...evidenceLocation(project.project_id, reference), returnPage: visiblePage }, snippet: reference.snippet });
  }

  function closeAssistant() {
    setAssistantOpen(false);
    assistantToggle.current?.focus();
  }

  const toggleAssistant = useCallback(() => {
    if (desktopHud) {
      void toggleXiaoJingWindow().catch((error) => onXiaoJingError?.(`无法切换小镜窗口：${errorMessage(error)}`));
      return;
    }
    setAssistantOpen((value) => !value);
    if (assistantOpen) assistantToggle.current?.focus();
  }, [assistantOpen, desktopHud, onXiaoJingError]);

  function nextIntent(
    workspace: ProductionWorkspace,
    context: ProductionSelectionContext = currentSelection,
  ): ProductionNavigationIntent {
    navigationNonce.current += 1;
    return {
      ...context,
      projectId: project.project_id,
      workspace,
      nonce: navigationNonce.current,
    };
  }

  function navigate(next: ProductionPage): void {
    if (next.startsWith("sync-") && project.input_kind !== "media-directory") {
      setPage("slate");
      return;
    }
    if (syncBlocked && !["sync-task", "media-library", "media-binding"].includes(next)) return;
    if (next === "delivery") {
      setDeliveryRequestNonce((value) => value + 1);
      setPage("timeline");
      return;
    }
    if (next === "media-binding" && visiblePage !== "media-binding") setReturnPage(visiblePage);
    setPage(safeProductionPage(next));
  }

  function switchArea(next: ProductionArea, target?: ProductionPage): void {
    if (syncBlocked && next !== "timeline" && next !== "material") return;
    if (next !== area) setNavigationIntent(nextIntent(next));
    navigate(target ?? (syncBlocked && next === "material" ? "media-library" : AREAS[next].defaultPage));
  }

  async function changeSyncTask(action: "start" | "cancel", restart = false): Promise<void> {
    if (commanding.current || readError) return;
    const projectId = project.project_id;
    const task = syncTimeline.task;
    if (action === "start" && syncTimeline.phase === "running") return;
    if (restart && master.ready && !globalThis.confirm("重新计算同步？现有交付文件保留在原版本。")) return;
    commanding.current = true;
    setCommand(action);
    setCommandError("");
    try {
      const tasks = new ProjectTaskClient(baseUrl);
      if (action === "cancel" && task) {
        await tasks.cancel(projectId, task.task_id);
      } else if (action === "start") {
        setPage("sync-task");
        const latest = task && canRetryTask(task) ? (await tasks.list(projectId)).find((row) => row.task_id === task.task_id) : null;
        if (latest?.type === "multicam_sync" && canRetryTask(latest)) await tasks.retry(projectId, latest);
        else await new DesktopClient(baseUrl).multicamSync(projectId);
        rememberSyncSubmissionIssue(workspaceId, projectId, "");
        setSubmissionIssue("");
      }
      onTaskChanged?.();
    } catch (error) {
      setCommandError(errorMessage(error));
    } finally {
      await refreshSyncTimeline();
      commanding.current = false;
      setCommand("");
    }
  }

  function runMulticamSync(): void { void changeSyncTask("start", master.ready); }

  function focusTake(
    groupId: string,
    destination: ProductionWorkspace,
    clipId?: string | null,
    scriptSegmentId?: string | null,
    location = currentSelection,
  ): void {
    const value = groupId.trim();
    if (!value) return;
    const target = destination === "material" ? "takes" : destination === "script" ? "script" : destination === "review" ? "watch" : "timeline";
    if (syncBlocked) return;
    const sameTake = location.groupId === value;
    const sameClip = sameTake && (!clipId || location.clipId === clipId);
    const context = normalizedContext(project.project_id, {
      groupId: value,
      clipId: clipId ?? (sameTake ? location.clipId : undefined),
      scriptSegmentId: scriptSegmentId ?? (currentSelection.groupId === value ? currentSelection.scriptSegmentId : undefined),
      mediaId: sameClip ? location.mediaId : undefined,
      recordId: sameTake ? location.recordId : undefined,
      sourceRange: sameClip ? location.sourceRange : undefined,
    });
    if (target !== visiblePage) setReturnPage(visiblePage);
    setSelection(context);
    setNavigationIntent(nextIntent(destination, context));
    navigate(target);
  }

  function openReviewWithoutSelection(): void {
    const context = { projectId: project.project_id };
    setSelection(context);
    setNavigationIntent(nextIntent("review", context));
    navigate("watch");
  }

  useEffect(() => {
    if (selection.projectId !== project.project_id) {
      setSelection({ projectId: project.project_id });
      setNavigationIntent(null);
    }
  }, [project.project_id, selection.projectId]);

  useEffect(() => {
    rememberProjectPage(project.project_id, page);
    onPageChange?.(page);
  }, [onPageChange, page, project.project_id]);

  useEffect(() => {
    onSyncStatusChange?.(project.project_id, master.ready, syncTimeline.phase);
  }, [master.ready, onSyncStatusChange, project.project_id, syncTimeline.phase]);


  useEffect(() => {
    if (visiblePage === "slate") setSlateVisited(true);
  }, [visiblePage]);

  useEffect(() => {
    if (!syncTimeline.task?.task_id || !submissionIssue) return;
    rememberSyncSubmissionIssue(workspaceId, project.project_id, "");
    setSubmissionIssue("");
  }, [workspaceId, project.project_id, syncTimeline.task?.task_id, submissionIssue]);

  useEffect(() => {
    if (!active || !pageRequest || handledPageRequest.current === pageRequest.nonce) return;
    if (syncTimeline.phase === "loading" && !["sync-task", "media-library", "media-binding"].includes(pageRequest.page)) return;
    handledPageRequest.current = pageRequest.nonce;
    navigate(pageRequest.page);
  }, [active, pageRequest?.nonce, syncTimeline.phase]);

  useEffect(() => {
    if (!desktopHud || !active || !externalXiaoJingAction || handledXiaoJingAction.current === externalXiaoJingAction.nonce) return;
    const action = externalXiaoJingAction;
    if (action.project_id && action.project_id !== project.project_id) return;
    const diagnostic = action.kind === "open_diagnostic" ? diagnosticPage(action.page) : undefined;
    if (syncTimeline.phase === "loading" && (action.kind === "focus_take" || diagnostic === "sync-delivery")) return;
    handledXiaoJingAction.current = action.nonce;
    if (diagnostic) navigate(diagnostic);
    if (action.kind === "focus_take" && action.group_id) {
      if (syncBlocked) {
        onXiaoJingError?.("同步完成后可在主窗口定位 Take。");
        return;
      }
      const destination = action.destination === "script" || action.destination === "review" || action.destination === "timeline"
        ? action.destination : "material";
      focusTake(action.group_id, destination, action.clip_id);
    }
  }, [active, desktopHud, externalXiaoJingAction, project.project_id, syncBlocked, syncTimeline.phase]);

  useEffect(() => {
    if (!active || !desktopHud) return;
    let sent = "";
    let timer: number | undefined;
    function publish() {
      timer = undefined;
      const contextSelection = pageFocus.current ?? selectionContext;
      const serialized = JSON.stringify(contextSelection);
      if (serialized === sent) return;
      sent = serialized;
      void syncXiaoJingContext({
        base_url: baseUrl,
        workspace_id: workspaceId,
        workspace_name: xiaojingWorkspace?.workspace_name ?? "",
        projects: xiaojingWorkspace?.projects ?? [{ project_id: project.project_id, name: project.name, input_kind: project.input_kind }],
        project_id: project.project_id,
        project_name: project.name,
        current_page: visiblePage,
        selection: contextSelection,
        selection_summary: assistantSelectionSummary(contextSelection),
        appearance: xiaojingWorkspace?.appearance ?? "system",
      }).catch((error) => console.error("无法同步小镜上下文", error));
    }
    publish();
    // Sample the latest monitor position without invoking IPC on every
    // playback frame or introducing a React render for each playhead update.
    scheduleContextSync.current = () => { timer ??= window.setTimeout(publish, 100); };
    return () => {
      scheduleContextSync.current = null;
      window.clearTimeout(timer);
    };
  }, [active, baseUrl, desktopHud, pageFocus, project, selectionContext, visiblePage, workspaceId, xiaojingWorkspace]);

  useEffect(() => {
    if (!active || !desktopHud) return;
    let current = true;
    let receivedVisibility = false;
    let stop: (() => void) | undefined;
    void listenXiaoJingVisibilityChanged((visible) => {
      if (!current) return;
      receivedVisibility = true;
      setAssistantOpen(visible);
    }).then((unlisten) => {
      if (current) stop = unlisten;
      else unlisten();
    }).catch((error) => console.error("无法监听小镜窗口状态", error)).then(async () => {
      if (!current) return;
      const state = await readXiaoJingWindowState();
      if (current && !receivedVisibility) setAssistantOpen(state.visible);
    }).catch((error) => console.error("无法读取小镜窗口状态", error));
    return () => { current = false; stop?.(); };
  }, [active, desktopHud]);

  useEffect(() => {
    if (!active || desktopHud) return;
    function onKeyDown(event: KeyboardEvent) {
      if (event.defaultPrevented || event.isComposing || event.altKey || event.repeat) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        toggleAssistant();
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [active, desktopHud, toggleAssistant]);

  const assistantVisible = active && assistantOpen;
  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘J" : "Ctrl+J";

  return (
    <section
      className={`project-production-workbench professional-project-workbench${!desktopHud && assistantVisible ? " has-assistant-drawer" : ""}${!desktopHud && assistantVisible && assistantWide ? " has-assistant-wide" : ""}`}
      data-sync-read-error={Boolean(readError || (!syncTimeline.ready && snapshot)) || undefined}
      aria-label={`项目工作台：${project.name || project.project_id}`}
    >
      <header className="professional-project-toolbar" data-tauri-drag-region>
        <div className="professional-project-identity" data-tauri-drag-region>
          {projectNavigation ?? <strong>{project.name || project.project_id}</strong>}
          {visiblePage.startsWith("sync-") ? (
            <nav className="workbench-subbar sync-workbench-subbar" aria-label="同步工作区" data-tauri-drag-region="no-drag">
              {([
                ["sync-task", "同步任务"],
                ["sync-inspect", "同步核对"],
                ["sync-delivery", "工程交付"],
              ] as const).map(([target, label]) => {
                const available = target === "sync-task" || master.ready;
                return <button key={target} type="button" className="workbench-subbar-link" aria-current={visiblePage === target ? "page" : undefined}
                  disabled={!available} title={!available ? "同步完成后开放" : undefined}
                  onClick={() => navigate(target)}>{label}</button>;
              })}
            </nav>
          ) : ["media-library", "takes", "identity", "media-binding"].includes(visiblePage) ? (
            <nav className="workbench-subbar material-workbench-subbar" aria-label="素材工作区" data-tauri-drag-region="no-drag">
              <button type="button" className="workbench-subbar-link" aria-current={visiblePage === "media-library" ? "page" : undefined} onClick={() => navigate("media-library")}>全部文件</button>
              <button type="button" className="workbench-subbar-link" aria-current={visiblePage === "identity" ? "page" : undefined} disabled={syncBlocked} onClick={() => navigate("identity")}>演员与角色</button>
              {visiblePage === "takes" ? <button type="button" className="workbench-subbar-link" aria-current="page" onClick={() => navigate("takes")}>Take 镜次</button> : null}
              {visiblePage === "media-binding" ? <button type="button" className="workbench-subbar-link" aria-current="page" onClick={() => navigate("media-binding")}>换盘重连</button> : null}
            </nav>
          ) : visiblePage === "watch" || visiblePage === "timeline" ? (
            <nav className="workbench-subbar review-workbench-subbar" aria-label="审阅工作区" data-tauri-drag-region="no-drag">
              <button type="button" className="workbench-subbar-link" aria-current={visiblePage === "watch" ? "page" : undefined} onClick={() => navigate("watch")}>看片审阅</button>
              <button type="button" className="workbench-subbar-link" aria-current={visiblePage === "timeline" ? "page" : undefined} onClick={() => navigate("timeline")}>粗剪组接</button>
              {onOpenTeamReview ? <button type="button" className="workbench-subbar-link" onClick={onOpenTeamReview}>团队协作</button> : null}
            </nav>
          ) : (
            <span className="professional-project-context-subtitle" aria-live="polite">{pageLabel(visiblePage)}</span>
          )}
          {returnPage && returnPage !== visiblePage && visiblePage !== "media-binding" && !syncBlocked && <button type="button" className="secondary"
            data-tauri-drag-region="no-drag"
            onClick={() => { navigate(returnPage); setReturnPage(null); }}>返回{pageLabel(returnPage)}</button>}
        </div>
        <div className="professional-project-tools" data-tauri-drag-region>
          <span data-tauri-drag-region="no-drag">
            <SemanticSearchPalette active={active} baseUrl={baseUrl} projectId={project.project_id} onOpenEvidence={openEvidence} />
          </span>
          <button type="button" ref={assistantToggle} className={`professional-assistant-toggle${assistantOpen ? " is-active" : ""}`} aria-expanded={assistantOpen}
            aria-keyshortcuts="Meta+J Control+J" data-tauri-drag-region="no-drag" onClick={toggleAssistant}>
            <StudioIcon name="sparkle" size={13.5} />
            <span>小镜</span>
            <kbd aria-hidden="true">{shortcut}</kbd>
          </button>
          {(syncTimeline.phase === "running" || readError || commandError) ? (
            <span className={`professional-task-indicator${readError || commandError ? " is-error" : ""}`} role="status">
              <span className="professional-task-indicator-dot" aria-hidden="true" />
              {readError || commandError ? "任务需处理" : "同步中"}
            </span>
          ) : null}
        </div>
      </header>

      {(readError || (!syncTimeline.ready && snapshot)) && <div className="production-connection-notice" role={readError ? "alert" : "status"}>
        <span>{readError ? "同步状态读取失败。" : "本次同步尚未产生可核对的母版。"}
          {snapshot ? ` 正在显示 ${new Date(snapshot.readAt).toLocaleString()} 确认的母版。` : ` ${readError}`}</span>
        <button type="button" className="secondary" onClick={() => void refreshSyncTimeline()}>重新读取</button>
      </div>}
      <div className={`project-production-layout${showModuleRail ? "" : " without-module-rail"}`}>
        {showModuleRail ? <nav className="project-module-rail" aria-label="制作区域">
          <ProjectModuleNavigation inputKind={project.input_kind}
            selected={visiblePage} syncReady={master.ready} syncPhase={syncTimeline.phase}
            onNavigate={(target) => {
              if (canOpenProductionModule(target, project.input_kind, master.ready)) {
                switchArea(areaForPage(target), target);
              }
            }} />
          <div className="project-module-system" aria-label="系统工具">
            {onOpenStatus ? <button type="button" className="project-module-system-link" data-tauri-drag-region="no-drag" title="状态中心" onClick={onOpenStatus}>
              <StudioIcon name="activity" size={16} /><span>状态</span>
            </button> : null}
            {onOpenSettings ? <button type="button" className="project-module-system-link" data-tauri-drag-region="no-drag" title="设置" onClick={onOpenSettings}>
              <StudioIcon name="settings" size={16} /><span>设置</span>
            </button> : null}
          </div>
        </nav> : null}
      <div className="project-workbench-canvas">
        <div className="project-workbench-main owns-chrome">
          {active && visiblePage === "sync-task" ? (
            <SyncTaskWorkspace syncTimeline={syncTimeline} baseUrl={baseUrl} command={command}
              submissionError={commandError || submissionIssue}
              onMulticamSync={() => void changeSyncTask("start")}
              onCancel={() => void changeSyncTask("cancel")}
              onRepair={() => navigate("media-binding")} onOpenStatus={onOpenStatus}
              onInspect={master.ready ? () => navigate("sync-inspect") : undefined} />
          ) : null}
          {active && visiblePage === "sync-inspect" && master.ready ? (
            <SyncInspectionWorkbench syncTimeline={master} baseUrl={syncTimeline.ready ? baseUrl : undefined} onInspectSelection={inspectSelection}
              onMulticamSync={runMulticamSync} showDelivery={false}
              onTimelineUpdated={() => void refreshSyncTimeline()}
              onOpenDelivery={() => navigate("sync-delivery")} />
          ) : null}
          {active && visiblePage === "sync-delivery" && master.ready ? (
            <SyncDeliveryWorkspace baseUrl={baseUrl} syncTimeline={master} canGenerate={syncTimeline.ready && !readError} onRepair={() => navigate("media-binding")}
              onInspect={() => navigate("sync-inspect")} onSyncTask={() => navigate("sync-task")} onOpenAssembly={() => navigate("timeline")} />
          ) : null}

          {((active && area === "material") || slateVisited) ? (
            <MaterialWorkspace
              baseUrl={baseUrl}
              project={project}
              slateDraftSession={slateDraftSession}
              active={active && area === "material"}
              keepSlate={slateVisited}
              showViewNavigation={false}
              view={materialViewForPage(visiblePage)}
              canOpenTakes={!syncBlocked}
              slateFocus={slateFocus}
              onOpenEvidence={openEvidence}
              onSlateSelection={selectSlateRecord}
              onOpenSlateTake={(destination, location) => {
                if (location.groupId) focusTake(location.groupId, destination, location.clipId, undefined, location);
              }}
              repairReturnLabel={returnPage && returnPage !== "media-binding" ? `返回${pageLabel(returnPage)}` : undefined}
              onReturnFromRepair={returnPage && returnPage !== "media-binding" ? () => {
                navigate(returnPage);
                setReturnPage(null);
              } : undefined}
              onInspectSelection={inspectSelection}
              initialGroupId={currentSelection.groupId ?? null}
              initialClipId={currentSelection.clipId ?? null}
              playbackFocus={currentSelection}
              onSelectionChange={(groupId, clipId) => updateSelection({ groupId, clipId })}
              onViewChange={(view, groupId) => {
                if (groupId?.trim()) updateSelection({ groupId });
                if (view === "takes") setReturnPage(visiblePage);
                navigate(pageForMaterialView(view));
              }}
              onOpenScript={(groupId, clipId) => focusTake(groupId, "script", clipId)}
              onOpenReview={(groupId, clipId) => groupId ? focusTake(groupId, "review", clipId) : openReviewWithoutSelection()}
              onOpenTimeline={(groupId, clipId) => focusTake(groupId, "timeline", clipId)}
            />
          ) : null}

          {active && visiblePage === "script" ? (
            <ScriptWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={currentSelection.groupId ?? null}
              initialClipId={currentSelection.clipId ?? null}
              initialScriptSegmentId={currentSelection.scriptSegmentId ?? null}
              playbackFocus={currentSelection}
              onSelectionChange={(groupId, clipId, scriptSegmentId) => updateSelection({ groupId, clipId, scriptSegmentId })}
              onOpenMaterial={(groupId, clipId) => focusTake(groupId, "material", clipId, currentSelection.scriptSegmentId)}
              onOpenReview={(groupId, clipId, scriptSegmentId) => focusTake(groupId, "review", clipId, scriptSegmentId)}
              onOpenTimeline={(groupId, clipId, scriptSegmentId) => focusTake(groupId, "timeline", clipId, scriptSegmentId)}
            />
          ) : null}

          {active && visiblePage === "timeline" ? (
            <TimelineWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              syncTimeline={master}
              initialAssemblyExpanded={project.input_kind === "media-directory"}
              onMulticamSync={runMulticamSync}
              focusIntent={currentIntent?.workspace === "timeline" ? currentIntent : null}
              deliveryRequestNonce={deliveryRequestNonce}
              onSelectionChange={(groupId, clipId, timelineClipId) => updateSelection({ groupId, clipId, timelineClipId, scriptSegmentId: currentSelection.scriptSegmentId })}
              onOpenRepair={() => navigate("media-binding")}
            />
          ) : null}

          {active && visiblePage === "watch" ? (
            <ReviewWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={currentSelection.groupId ?? null}
              initialClipId={currentSelection.clipId ?? null}
              playbackFocus={currentSelection}
              onSelectionChange={(groupId, clipId) => updateSelection({ groupId, clipId, scriptSegmentId: currentSelection.scriptSegmentId })}
              onOpenMaterial={(groupId, clipId) => focusTake(groupId, "material", clipId, currentSelection.scriptSegmentId)}
              onOpenScript={(groupId, clipId) => focusTake(groupId, "script", clipId, currentSelection.scriptSegmentId)}
              onOpenTimeline={(groupId, clipId) => focusTake(groupId, "timeline", clipId, currentSelection.scriptSegmentId)}
            />
          ) : null}
        </div>

        {!desktopHud && assistantVisible ? (
          <aside className="assistant-context-drawer" {...(assistantWide && { className: "assistant-context-drawer is-wide" })}
            aria-label="小镜上下文助手" onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); closeAssistant(); }
          }}>
            <div className="assistant-drawer-heading">
              <div><strong>小镜</strong><span>{pageLabel(visiblePage)}</span></div>
              <div className="assistant-drawer-tools">
                <button type="button" className="secondary" aria-pressed={assistantWide}
                  onClick={() => setAssistantWide((value) => !value)}>{assistantWide ? "标准" : "加宽"}</button>
                <button type="button" className="secondary" onClick={closeAssistant} aria-label="关闭小镜">关闭</button>
              </div>
            </div>
            <AssistantWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              active={assistantVisible}
              currentPage={visiblePage}
              selectionSummary={selectionSummary}
              draft={assistantDraft}
              readContext={(includeSelection) => ({
                project_id: project.project_id,
                page: visiblePage,
                ...(includeSelection ? (pageFocus.current ?? selectionContext) : {}),
              })}
              onOpenEvidence={openEvidence}
              onOpenDiagnostic={(target) => { closeAssistant(); navigate(target); }}
              onOpenSettings={onOpenSettings}
              onOpenStatus={onOpenStatus}
              onTaskSubmitted={onTaskChanged}
              onFocusTake={syncBlocked ? undefined : (groupId, destination, clipId) => {
                closeAssistant();
                focusTake(groupId, destination ?? "material", clipId);
              }}
            />
          </aside>
        ) : null}
      </div>
      </div>
      {active && evidence && <EvidencePreview baseUrl={baseUrl} selection={evidence.selection} snippet={evidence.snippet}
        onClose={() => setEvidence(null)}
        onRepair={() => { setEvidence(null); navigate("media-binding"); }}
        onOpenObject={evidence.selection.recordId && !syncBlocked ? () => {
          setSelection(evidence.selection);
          setSlateFocus(evidence.selection);
          setReturnPage(evidence.selection.returnPage ?? null);
          setEvidence(null);
          navigate("slate");
        } : evidence.selection.groupId && !syncBlocked ? () => {
          setSelection(evidence.selection);
          setReturnPage(evidence.selection.returnPage ?? null);
          setEvidence(null);
          navigate("takes");
        } : undefined} />}
    </section>
  );
}
