import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { readProjectPage, rememberProjectPage, type ProductionPage } from "../../app/resumeState";
import { CurrentOperatorControl } from "../../components/CurrentOperatorControl";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { DeliveryWorkbench } from "../delivery/DeliveryWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import { MaterialWorkspace, type MaterialView } from "../material/MaterialWorkspace";
import "../media/media.css";
import { ReviewWorkspace } from "../review/ReviewWorkspace";
import { ScriptWorkspace } from "../script/ScriptWorkspace";
import "../script/script-workspace.css";
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

type ProductionArea = "material" | "script" | "timeline" | "review";

interface AreaPageDefinition {
  page: ProductionPage;
  label: string;
  hidden?: boolean;
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
      { page: "media-binding", label: "本机素材", hidden: true },
    ],
  },
  script: {
    label: "剧本",
    defaultPage: "script",
    pages: [
      { page: "script", label: "剧本" },
    ],
  },
  timeline: {
    label: "时间线",
    defaultPage: "timeline",
    pages: [
      { page: "timeline", label: "时间线" },
      { page: "delivery", label: "交付" },
    ],
  },
  review: {
    label: "审阅",
    defaultPage: "watch",
    pages: [
      { page: "watch", label: "看片" },
    ],
  },
};

const ALL_PAGES = new Set<ProductionPage>(Object.values(AREAS).flatMap((area) => area.pages.map((item) => item.page)));

function safeProductionPage(page: ProductionPage): ProductionPage {
  if (page === "coverage") return "script";
  if (page === "rough-cut" || page === "assembly") return "timeline";
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
  const [focusedTakeGroupId, setFocusedTakeGroupId] = useState<string | null>(null);
  const [operatorRevision, setOperatorRevision] = useState(0);

  const area = areaForPage(page);
  const areaDefinition = AREAS[area];
  const visibleAreaPages = areaDefinition.pages.filter((item) => !item.hidden);
  const currentPageDefinition = areaDefinition.pages.find((item) => item.page === page) ?? null;
  const showSecondaryNavigation = area !== "material" && (visibleAreaPages.length > 1 || Boolean(currentPageDefinition?.hidden));

  function navigate(next: ProductionPage): void {
    setPage(safeProductionPage(next));
  }

  function switchArea(next: ProductionArea): void {
    if (next === area) return;
    navigate(AREAS[next].defaultPage);
  }

  function focusTake(groupId: string, destination: "takes" | "script" | "watch" | "timeline"): void {
    const value = groupId.trim();
    if (!value) return;
    setFocusedTakeGroupId(value);
    navigate(destination);
  }

  useEffect(() => {
    rememberProjectPage(project.project_id, page);
    onPageChange?.(page);
  }, [onPageChange, page, project.project_id]);

  useEffect(() => {
    if (pageRequest) navigate(pageRequest.page);
  }, [pageRequest?.nonce]);

  const assistantVisible = assistantOpen;
  const canvasScope = area === "material" ? "material" : page;
  const canvasKey = `${project.project_id}:${canvasScope}:operator-${operatorRevision}`;
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

      {showSecondaryNavigation ? (
        <nav className="professional-secondary-nav" aria-label={`${AREAS[area].label}工作区`}>
          <div className="professional-secondary-pages">
            {visibleAreaPages.map((item) => (
              <button
                type="button"
                className={page === item.page ? "is-active" : ""}
                aria-current={page === item.page ? "page" : undefined}
                key={item.page}
                onClick={() => navigate(item.page)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <span className="professional-page-context">{AREAS[area].label} / {pageLabel(page)}</span>
        </nav>
      ) : null}

      <div className="project-workbench-canvas">
        <div className="project-workbench-main owns-chrome" key={canvasKey}>
          {area === "material" ? (
            <MaterialWorkspace
              baseUrl={baseUrl}
              project={project}
              view={materialViewForPage(page)}
              initialGroupId={focusedTakeGroupId}
              onViewChange={(view, groupId) => {
                if (groupId?.trim()) setFocusedTakeGroupId(groupId.trim());
                navigate(pageForMaterialView(view));
              }}
              onOpenScript={(groupId) => focusTake(groupId, "script")}
              onOpenReview={(groupId) => {
                if (!groupId?.trim()) setFocusedTakeGroupId(null);
                groupId ? focusTake(groupId, "watch") : navigate("watch");
              }}
              onOpenTimeline={(groupId) => focusTake(groupId, "timeline")}
            />
          ) : null}

          {page === "script" ? (
            <ScriptWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={focusedTakeGroupId}
            />
          ) : null}

          {page === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "delivery" ? <DeliveryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

          {page === "watch" ? (
            <ReviewWorkspace
              baseUrl={baseUrl}
              project={project}
              initialGroupId={focusedTakeGroupId}
              onOpenScript={(groupId) => focusTake(groupId, "script")}
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
