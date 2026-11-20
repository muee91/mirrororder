import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { errorMessage, type ProjectSummary } from "../../api/host";
import { DesktopClient } from "../../api/desktop";
import type { AssistantSelection } from "../../api/production";
import { ProjectTaskClient, canRetryTask } from "../../api/tasks";
import { EvidencePreview } from "./EvidencePreview";
import { evidenceLocation, type EvidenceReference } from "./evidenceLocation";
import { canonicalProductionPage, hasRememberedProjectPage, readProjectPage, rememberProjectPage, readSyncSubmissionIssue, rememberSyncSubmissionIssue, type ProductionPage } from "../../app/resumeState";
import { CurrentOperatorControl } from "../../components/CurrentOperatorControl";
import { StudioIcon } from "../../components/StudioIcons";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { SemanticSearchPalette } from "../search/SemanticSearchPalette";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import { SyncTaskWorkspace } from "../editor/MulticamSyncTimeline";
import { SyncInspectionWorkbench } from "../editor/SyncInspectionWorkbench";
import { SyncDeliveryWorkspace } from "../editor/SyncDeliveryWorkspace";
import { ProjectModuleNavigation, canOpenProductionModule } from "./ProjectModuleNavigation";
import { MaterialWorkspace, type MaterialView } from "../material/MaterialWorkspace";
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
  active?: boolean;
  projectNavigation?: ReactNode;
  systemTools?: ReactNode;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  onOpenTeamReview?: () => void;
  onTaskChanged?: () => void;
  onOpenStatus?: () => void;
  onPageChange?: (page: ProductionPage) => void;
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

export function ProjectWorkbench({ baseUrl, project, workspaceId = baseUrl, active = true, projectNavigation, systemTools, pageRequest = null, onOpenTeamReview, onTaskChanged, onOpenStatus, onPageChange }: Props) {
  const [page, setPage] = useState<ProductionPage>(() => {
    const saved = safeProductionPage(readProjectPage(project.project_id));
    if (project.input_kind === "media-directory") {
      if (!hasRememberedProjectPage(project.project_id)) return "sync-task";
    }
    return saved;
  });
  const [assistantOpen, setAssistantOpen] = useState(false);
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
  const assistantDraft = useMemo(() => ({ text: "", includeSelection: true }), [baseUrl, project.project_id]);
  const navigationNonce = useRef(0);
  const { syncTimeline, snapshot, readError, refreshSyncTimeline } = useMulticamSyncGate(baseUrl, project.project_id, project.input_kind);
  const master = syncTimeline.ready ? syncTimeline : snapshot?.timeline ?? syncTimeline;
  const syncBlocked = project.input_kind === "media-directory" && !master.ready;
  const visiblePage = syncBlocked
    && !["sync-task", "media-library", "media-binding"].includes(page) ? "sync-task" : page;

  const area = areaForPage(visiblePage);
  const currentSelection = selection.projectId === project.project_id ? selection : { projectId: project.project_id };
  const pageFocus = useMemo<{ current: AssistantSelection }>(() => ({ current: {} }), [project.project_id, visiblePage]);
  const inspectSelection = useCallback((next: AssistantSelection) => { pageFocus.current = next; }, [pageFocus]);
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
    if (visiblePage === "slate") setSlateVisited(true);
  }, [visiblePage]);

  useEffect(() => {
    if (!syncTimeline.task?.task_id || !submissionIssue) return;
    rememberSyncSubmissionIssue(workspaceId, project.project_id, "");
    setSubmissionIssue("");
  }, [workspaceId, project.project_id, syncTimeline.task?.task_id, submissionIssue]);

  useEffect(() => {
    if (pageRequest) navigate(pageRequest.page);
  }, [pageRequest?.nonce]);

  const assistantVisible = active && assistantOpen;


  return (
    <section
      className={`project-production-workbench professional-project-workbench ${assistantVisible ? "has-assistant-drawer" : ""}`}
      data-sync-read-error={Boolean(readError || (!syncTimeline.ready && snapshot)) || undefined}
      aria-label={`项目工作台：${project.name || project.project_id}`}
    >
      <header className="professional-project-toolbar">
        <div className="professional-project-identity">
          {projectNavigation ?? <strong>{project.name || project.project_id}</strong>}
          {returnPage && returnPage !== visiblePage && visiblePage !== "media-binding" && !syncBlocked && <button type="button" className="secondary"
            onClick={() => { navigate(returnPage); setReturnPage(null); }}>返回{pageLabel(returnPage)}</button>}
        </div>
        <div className="professional-project-tools">
          <SemanticSearchPalette active={active} baseUrl={baseUrl} projectId={project.project_id} onOpenEvidence={openEvidence} />
          <button type="button" ref={assistantToggle} className={`professional-assistant-toggle${assistantOpen ? " is-active" : ""}`} aria-expanded={assistantOpen}
            onClick={() => setAssistantOpen((value) => !value)}>
            <StudioIcon name="sparkle" size={13.5} />
            <span>小镜</span>
          </button>
          {!syncBlocked && onOpenTeamReview ? (
            <button type="button" className="secondary professional-team-review" onClick={onOpenTeamReview}>
              <StudioIcon name="team" size={13.5} />
              <span>团队审阅</span>
            </button>
          ) : null}
          <details className="professional-tools-menu">
            <summary>
              <StudioIcon name="tools" size={13.5} />
              <span>工具</span>
            </summary>
            <div className="professional-tools-popover">
              <CurrentOperatorControl />
            </div>
          </details>
          {systemTools && <div className="professional-project-system">{systemTools}</div>}
        </div>
      </header>

      {(readError || (!syncTimeline.ready && snapshot)) && <div className="production-connection-notice" role={readError ? "alert" : "status"}>
        <span>{readError ? "同步状态读取失败。" : "本次同步尚未产生可核对的母版。"}
          {snapshot ? ` 正在显示 ${new Date(snapshot.readAt).toLocaleString()} 确认的母版。` : ` ${readError}`}</span>
        <button type="button" className="secondary" onClick={() => void refreshSyncTimeline()}>重新读取</button>
      </div>}
      <div className="project-production-layout">
        <nav className="project-module-rail" aria-label="制作区域">
          <ProjectModuleNavigation inputKind={project.input_kind}
            selected={visiblePage} syncReady={master.ready} syncPhase={syncTimeline.phase}
            onNavigate={(target) => {
              if (canOpenProductionModule(target, project.input_kind, master.ready)) {
                switchArea(areaForPage(target), target);
              }
            }} />
        </nav>
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
              onInspect={() => navigate("sync-inspect")} onSyncTask={() => navigate("sync-task")} />
          ) : null}

          {((active && area === "material") || slateVisited) ? (
            <MaterialWorkspace
              baseUrl={baseUrl}
              project={project}
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

        {assistantVisible ? (
          <aside className="assistant-context-drawer" aria-label="小镜上下文助手" onKeyDown={(event) => {
            if (event.key === "Escape" && !event.nativeEvent.isComposing) { event.stopPropagation(); closeAssistant(); }
          }}>
            <div className="assistant-drawer-heading">
            <div><p className="eyebrow">{AREAS[area].label} / {pageLabel(visiblePage)}</p><strong>小镜</strong></div>
              <button type="button" className="secondary" onClick={closeAssistant} aria-label="关闭小镜">关闭</button>
            </div>
            <AssistantWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              draft={assistantDraft}
              readContext={(includeSelection) => ({
                project_id: project.project_id,
                page: visiblePage,
                ...(includeSelection ? (Object.keys(pageFocus.current).length ? pageFocus.current : {
                  group_id: currentSelection.groupId, clip_id: currentSelection.clipId,
                  media_id: currentSelection.mediaId, script_segment_id: currentSelection.scriptSegmentId,
                }) : {}),
              })}
              onOpenEvidence={openEvidence}
              onOpenDiagnostic={(target) => { closeAssistant(); navigate(target); }}
              onFocusTake={(groupId, destination, clipId) => {
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
