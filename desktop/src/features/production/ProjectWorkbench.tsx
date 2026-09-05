import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { readProjectPage, rememberProjectPage, type ProductionPage } from "../../app/resumeState";
import { CurrentOperatorControl } from "../../components/CurrentOperatorControl";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import { MaterialWorkspace, type MaterialView } from "../material/MaterialWorkspace";
import "../media/media.css";
import { ReviewWorkspace } from "../review/ReviewWorkspace";
import { ScriptWorkspace } from "../script/ScriptWorkspace";
import "../script/script-workspace.css";
import type { ProductionNavigationIntent, ProductionWorkspace } from "./productionNavigation";
import "./production.css";
import "./assistant-drawer.css";
import "./product-experience.css";
import "./secondary-tools-theme.css";
import "./professional-project-workbench.css";
import "./production-workspaces.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  onOpenTeamReview?: () => void;
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
  if (page === "coverage") return "script";
  if (page === "rough-cut" || page === "assembly" || page === "delivery") return "timeline";
  if (page === "attention" || page === "overview") return "watch";
  return ALL_PAGES.has(page) ? page : "slate";
}

function areaForPage(page: ProductionPage): ProductionArea {
  const canonical = safeProductionPage(page);
  for (const [key, area] of Object.entries(AREAS) as Array<[ProductionArea, AreaDefinition]>) {
    if (area.pages.some((item) => item.page === canonical)) return key;
  }
  return "material";
}

function pageLabel(page: ProductionPage): string {
  const canonical = safeProductionPage(page);
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

export function ProjectWorkbench({ baseUrl, project, pageRequest = null, onOpenTeamReview, onPageChange }: Props) {
  const [page, setPage] = useState<ProductionPage>(() => safeProductionPage(readProjectPage(project.project_id)));
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [navigationIntent, setNavigationIntent] = useState<ProductionNavigationIntent | null>(null);
  const [deliveryRequestNonce, setDeliveryRequestNonce] = useState(0);
  const [operatorRevision, setOperatorRevision] = useState(0);
  const navigationNonce = useRef(0);

  const area = areaForPage(page);
  const currentIntent = navigationIntent?.projectId === project.project_id ? navigationIntent : null;

  function nextIntent(
    workspace: ProductionWorkspace,
    groupId?: string | null,
    clipId?: string | null,
  ): ProductionNavigationIntent {
    navigationNonce.current += 1;
    return {
      projectId: project.project_id,
      workspace,
      nonce: navigationNonce.current,
      ...(groupId?.trim() ? { groupId: groupId.trim() } : {}),
      ...(clipId?.trim() ? { clipId: clipId.trim() } : {}),
    };
  }

  function navigate(next: ProductionPage): void {
    if (next === "delivery") {
      setDeliveryRequestNonce((value) => value + 1);
      setPage("timeline");
      return;
    }
    setPage(safeProductionPage(next));
  }

  function switchArea(next: ProductionArea): void {
    if (next === area) return;
    if (currentIntent) {
      navigationNonce.current += 1;
      setNavigationIntent({ ...currentIntent, workspace: next, nonce: navigationNonce.current });
    }
    navigate(AREAS[next].defaultPage);
  }

  function focusTake(
    groupId: string,
    destination: "material" | "script" | "review" | "timeline",
    clipId?: string | null,
  ): void {
    const value = groupId.trim();
    if (!value) return;
    setNavigationIntent(nextIntent(destination, value, clipId));
    navigate(destination === "material" ? "takes" : destination === "script" ? "script" : destination === "review" ? "watch" : "timeline");
  }

  function openReviewWithoutSelection(): void {
    setNavigationIntent(null);
    navigate("watch");
  }

  useEffect(() => {
    rememberProjectPage(project.project_id, page);
    onPageChange?.(page);
  }, [onPageChange, page, project.project_id]);

  useEffect(() => {
    if (pageRequest) navigate(pageRequest.page);
  }, [pageRequest?.nonce]);

  const assistantVisible = assistantOpen;
  const canvasKey = `${project.project_id}:${area}:operator-${operatorRevision}`;
  const primaryNavigation = useMemo(() => Object.entries(AREAS) as Array<[ProductionArea, AreaDefinition]>, []);

  return (
    <section className={`project-production-workbench professional-project-workbench ${assistantVisible ? "has-assistant-drawer" : ""}`}>
      <header className="professional-project-toolbar">
        <div className="professional-project-identity">
          <span>当前项目</span>
          <strong title={project.name || project.project_id}>{project.name || project.project_id}</strong>
        </div>
        <nav className="professional-area-nav" aria-label="制作区域">
          {primaryNavigation.map(([key, definition]) => (
            <button
              type="button"
              className={area === key ? "is-active" : ""}
              aria-current={area === key ? "page" : undefined}
              key={key}
              onClick={() => switchArea(key)}
            >
              {definition.label}
            </button>
          ))}
        </nav>
        <div className="professional-project-tools">
          <CurrentOperatorControl onChange={() => setOperatorRevision((value) => value + 1)} />
          <button type="button" className={`professional-assistant-toggle ${assistantOpen ? "is-active" : ""}`} onClick={() => setAssistantOpen((value) => !value)} aria-pressed={assistantOpen}>小镜</button>
          {onOpenTeamReview ? <button type="button" className="secondary professional-team-review" onClick={onOpenTeamReview}>团队审阅</button> : null}
        </div>
      </header>

      <div className="project-workbench-canvas">
        <div className="project-workbench-main owns-chrome" key={canvasKey}>
          {area === "material" ? (
            <MaterialWorkspace
              baseUrl={baseUrl}
              project={project}
              view={materialViewForPage(page)}
              initialGroupId={currentIntent?.groupId ?? null}
              onViewChange={(view, groupId) => {
                if (groupId?.trim()) setNavigationIntent(nextIntent("material", groupId));
                navigate(pageForMaterialView(view));
              }}
              onOpenScript={(groupId) => focusTake(groupId, "script")}
              onOpenReview={(groupId) => groupId ? focusTake(groupId, "review") : openReviewWithoutSelection()}
              onOpenTimeline={(groupId) => focusTake(groupId, "timeline")}
            />
          ) : null}

          {page === "script" ? (
            <ScriptWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={currentIntent?.groupId ?? null}
            />
          ) : null}

          {page === "timeline" ? (
            <TimelineWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              focusIntent={currentIntent?.workspace === "timeline" ? currentIntent : null}
              deliveryRequestNonce={deliveryRequestNonce}
            />
          ) : null}

          {page === "watch" ? (
            <ReviewWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={currentIntent?.groupId ?? null}
              onOpenScript={(groupId) => focusTake(groupId, "script")}
              onOpenTimeline={(groupId, clipId) => focusTake(groupId, "timeline", clipId)}
            />
          ) : null}
        </div>

        {assistantVisible ? (
          <aside className="assistant-context-drawer" aria-label="小镜上下文助手">
            <div className="assistant-drawer-heading">
              <div><p className="eyebrow">{AREAS[area].label} / {pageLabel(page)}</p><strong>小镜</strong></div>
              <button type="button" className="secondary" onClick={() => setAssistantOpen(false)} aria-label="关闭小镜">关闭</button>
            </div>
            <AssistantWorkbench baseUrl={baseUrl} projectId={project.project_id} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
