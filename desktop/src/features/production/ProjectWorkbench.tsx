import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { canonicalProductionPage, hasRememberedProjectPage, readProjectPage, rememberProjectPage, type ProductionPage } from "../../app/resumeState";
import { CurrentOperatorControl } from "../../components/CurrentOperatorControl";
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
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  onOpenTeamReview?: () => void;
  onMulticamSync?: () => void;
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
  if (canonical === "sync-delivery") return "工程交付";
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
    ...(scriptSegmentId ? { scriptSegmentId } : {}),
    ...(timelineClipId ? { timelineClipId } : {}),
  };
}

export function ProjectWorkbench({ baseUrl, project, pageRequest = null, onOpenTeamReview, onMulticamSync, onPageChange }: Props) {
  const [page, setPage] = useState<ProductionPage>(() => {
    const saved = safeProductionPage(readProjectPage(project.project_id));
    if (project.input_kind === "media-directory") {
      if (!hasRememberedProjectPage(project.project_id) || saved === "timeline") return "sync-task";
    }
    return saved;
  });
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [selection, setSelection] = useState<ProductionSelectionContext>(() => ({ projectId: project.project_id }));
  const [navigationIntent, setNavigationIntent] = useState<ProductionNavigationIntent | null>(null);
  const [deliveryRequestNonce, setDeliveryRequestNonce] = useState(0);
  const [operatorRevision, setOperatorRevision] = useState(0);
  const navigationNonce = useRef(0);
  const { syncTimeline, beginSyncTracking, refreshSyncTimeline } = useMulticamSyncGate(baseUrl, project.project_id, project.input_kind);
  const syncBlocked = project.input_kind === "media-directory" && !syncTimeline.ready;
  const visiblePage = syncBlocked
    && !["sync-task", "media-library", "media-binding"].includes(page) ? "sync-task" : page;

  const area = areaForPage(visiblePage);
  const currentSelection = selection.projectId === project.project_id ? selection : { projectId: project.project_id };
  const currentIntent = navigationIntent?.projectId === project.project_id ? navigationIntent : null;

  const updateSelection = useCallback((values: ProductionSelectionValues): void => {
    setSelection(normalizedContext(project.project_id, values));
  }, [project.project_id]);

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
    if (syncBlocked && !["sync-task", "media-library", "media-binding"].includes(next)) {
      setPage("sync-task");
      return;
    }
    if (next === "delivery") {
      setDeliveryRequestNonce((value) => value + 1);
      setPage("timeline");
      return;
    }
    setPage(safeProductionPage(next));
  }

  function switchArea(next: ProductionArea, target?: ProductionPage): void {
    if (syncBlocked && next !== "timeline" && next !== "material") return;
    if (next !== area) setNavigationIntent(nextIntent(next));
    navigate(target ?? (syncBlocked && next === "material" ? "media-library" : AREAS[next].defaultPage));
  }

  function runMulticamSync(): void {
    if (syncTimeline.ready && !globalThis.confirm(
      "重新同步会更新项目本机的同步结果。已分发给剪辑师的工程应单独保留版本。确认重新计算吗？",
    )) return;
    beginSyncTracking();
    onMulticamSync?.();
    setPage("sync-task");
    globalThis.setTimeout(() => { void refreshSyncTimeline(); }, 500);
  }

  function focusTake(
    groupId: string,
    destination: ProductionWorkspace,
    clipId?: string | null,
    scriptSegmentId?: string | null,
  ): void {
    const value = groupId.trim();
    if (!value) return;
    const context = normalizedContext(project.project_id, {
      groupId: value,
      clipId,
      scriptSegmentId,
    });
    setSelection(context);
    setNavigationIntent(nextIntent(destination, context));
    navigate(destination === "material" ? "takes" : destination === "script" ? "script" : destination === "review" ? "watch" : "timeline");
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
    if (syncBlocked && !["sync-task", "media-library", "media-binding"].includes(page)) {
      setPage("sync-task");
    }
  }, [page, syncBlocked]);

  useEffect(() => {
    if (pageRequest) navigate(pageRequest.page);
  }, [pageRequest?.nonce]);

  const assistantVisible = assistantOpen;
  const canvasKey = `${project.project_id}:${area}:operator-${operatorRevision}`;

  return (
    <section
      className={`project-production-workbench professional-project-workbench ${assistantVisible ? "has-assistant-drawer" : ""}`}
      aria-label={`项目工作台：${project.name || project.project_id}`}
    >
      <header className="professional-project-toolbar">
        <div className="professional-project-identity">
          <span>当前剧集 · 镜序制作</span>
          <strong>{project.name || project.project_id}</strong>
          <small>{pageLabel(visiblePage)}</small>
        </div>
        <div className="professional-project-tools">
          {!syncBlocked ? <SemanticSearchPalette baseUrl={baseUrl} projectId={project.project_id} onOpenTake={(groupId) => focusTake(groupId, "script")} /> : null}
          {!syncBlocked && onOpenTeamReview ? <button type="button" className="secondary professional-team-review" onClick={onOpenTeamReview}>审阅</button> : null}
          {!syncBlocked ? <details className="professional-tools-menu">
            <summary>工具</summary>
            <div className="professional-tools-popover">
              <CurrentOperatorControl onChange={() => setOperatorRevision((value) => value + 1)} />
              <button type="button" className={`professional-assistant-toggle ${assistantOpen ? "is-active" : ""}`} onClick={() => setAssistantOpen((value) => !value)} aria-pressed={assistantOpen}>小镜</button>
            </div>
          </details> : <span className="professional-sync-context">先同步 · 需要时检查原始素材</span>}
        </div>
      </header>

      <div className="project-production-layout">
        <nav className="project-module-rail" aria-label="制作区域">
          <ProjectModuleNavigation inputKind={project.input_kind}
            selected={visiblePage} syncReady={syncTimeline.ready} syncPhase={syncTimeline.phase}
            onNavigate={(target) => {
              if (canOpenProductionModule(target, project.input_kind, syncTimeline.ready)) {
                switchArea(areaForPage(target), target);
              }
            }} />
        </nav>
      <div className="project-workbench-canvas">
        <div className="project-workbench-main owns-chrome" key={canvasKey}>
          {visiblePage === "sync-task" ? (
            <SyncTaskWorkspace syncTimeline={syncTimeline} onMulticamSync={runMulticamSync}
              onInspect={() => navigate("sync-inspect")} />
          ) : null}
          {visiblePage === "sync-inspect" && syncTimeline.ready ? (
            <SyncInspectionWorkbench syncTimeline={syncTimeline} baseUrl={baseUrl}
              onMulticamSync={runMulticamSync} showDelivery={false}
              onOpenDelivery={() => navigate("sync-delivery")} />
          ) : null}
          {visiblePage === "sync-delivery" && syncTimeline.ready ? (
            <SyncDeliveryWorkspace baseUrl={baseUrl} syncTimeline={syncTimeline}
              onInspect={() => navigate("sync-inspect")} onSyncTask={() => navigate("sync-task")} />
          ) : null}

          {area === "material" ? (
            <MaterialWorkspace
              baseUrl={baseUrl}
              project={project}
              view={materialViewForPage(page)}
              initialGroupId={currentSelection.groupId ?? null}
              initialClipId={currentSelection.clipId ?? null}
              onSelectionChange={(groupId, clipId) => updateSelection({ groupId, clipId })}
              onViewChange={(view, groupId) => {
                if (groupId?.trim()) updateSelection({ groupId });
                navigate(pageForMaterialView(view));
              }}
              onOpenScript={(groupId, clipId) => focusTake(groupId, "script", clipId)}
              onOpenReview={(groupId, clipId) => groupId ? focusTake(groupId, "review", clipId) : openReviewWithoutSelection()}
              onOpenTimeline={(groupId, clipId) => focusTake(groupId, "timeline", clipId)}
            />
          ) : null}

          {visiblePage === "script" ? (
            <ScriptWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={currentSelection.groupId ?? null}
              initialClipId={currentSelection.clipId ?? null}
              initialScriptSegmentId={currentSelection.scriptSegmentId ?? null}
              onSelectionChange={(groupId, clipId, scriptSegmentId) => updateSelection({ groupId, clipId, scriptSegmentId })}
              onOpenMaterial={(groupId, clipId) => focusTake(groupId, "material", clipId, currentSelection.scriptSegmentId)}
              onOpenReview={(groupId, clipId, scriptSegmentId) => focusTake(groupId, "review", clipId, scriptSegmentId)}
              onOpenTimeline={(groupId, clipId, scriptSegmentId) => focusTake(groupId, "timeline", clipId, scriptSegmentId)}
            />
          ) : null}

          {visiblePage === "timeline" ? (
            <TimelineWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              syncTimeline={syncTimeline}
              initialAssemblyExpanded={project.input_kind === "media-directory"}
              onMulticamSync={runMulticamSync}
              focusIntent={currentIntent?.workspace === "timeline" ? currentIntent : null}
              deliveryRequestNonce={deliveryRequestNonce}
              onSelectionChange={(groupId, clipId, timelineClipId) => updateSelection({ groupId, clipId, timelineClipId, scriptSegmentId: currentSelection.scriptSegmentId })}
              onOpenRepair={() => navigate("media-binding")}
            />
          ) : null}

          {visiblePage === "watch" ? (
            <ReviewWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={currentSelection.groupId ?? null}
              initialClipId={currentSelection.clipId ?? null}
              onSelectionChange={(groupId, clipId) => updateSelection({ groupId, clipId, scriptSegmentId: currentSelection.scriptSegmentId })}
              onOpenMaterial={(groupId, clipId) => focusTake(groupId, "material", clipId, currentSelection.scriptSegmentId)}
              onOpenScript={(groupId, clipId) => focusTake(groupId, "script", clipId, currentSelection.scriptSegmentId)}
              onOpenTimeline={(groupId, clipId) => focusTake(groupId, "timeline", clipId, currentSelection.scriptSegmentId)}
            />
          ) : null}
        </div>

        {assistantVisible ? (
          <aside className="assistant-context-drawer" aria-label="小镜上下文助手">
            <div className="assistant-drawer-heading">
            <div><p className="eyebrow">{AREAS[area].label} / {pageLabel(visiblePage)}</p><strong>小镜</strong></div>
              <button type="button" className="secondary" onClick={() => setAssistantOpen(false)} aria-label="关闭小镜">关闭</button>
            </div>
            <AssistantWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              onFocusTake={(groupId, destination) => {
                setAssistantOpen(false);
                focusTake(groupId, destination ?? "material");
              }}
            />
          </aside>
        ) : null}
      </div>
      </div>
    </section>
  );
}
