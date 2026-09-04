import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { readProjectPage, rememberProjectPage, type ProductionPage } from "../../app/resumeState";
import { CurrentOperatorControl } from "../../components/CurrentOperatorControl";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { DeliveryWorkbench } from "../delivery/DeliveryWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { GoldenMaterialScriptWorkbench } from "../material-script/GoldenMaterialScriptWorkbench";
import { MaterialScriptWorkbench } from "../material-script/MaterialScriptWorkbench";
import "../material-script/material-script.css";
import { MediaBindingWorkbench } from "../media/MediaBindingWorkbench";
import { MediaLibraryWorkbench } from "../media/MediaLibraryWorkbench";
import "../media/media.css";
import { CoverageWorkbench } from "../planning/PlanningWorkbenches";
import { ProjectOverviewWorkbench, ReviewAttentionWorkbench } from "../review/ReviewWorkbenches";
import { GoldenSlateWorkbench } from "../slate/GoldenSlateWorkbench";
import { SlatePlaybackShortcuts } from "../slate/SlatePlaybackShortcuts";
import "./production.css";
import "./assistant-drawer.css";
import "./product-experience.css";
import "./secondary-tools-theme.css";
import "./professional-project-workbench.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  onOpenTeamReview?: () => void;
  onPageChange?: (page: ProductionPage) => void;
}

type ProductionArea = "material" | "script" | "edit" | "review";

interface AreaDefinition {
  label: string;
  defaultPage: ProductionPage;
  pages: Array<{ page: ProductionPage; label: string }>;
}

interface ReviewReturnContext {
  page: ProductionPage;
  label: string;
}

const AREAS: Record<ProductionArea, AreaDefinition> = {
  material: {
    label: "素材",
    defaultPage: "slate",
    pages: [
      { page: "slate", label: "场记" },
      { page: "media-library", label: "素材库" },
      { page: "takes", label: "镜次" },
      { page: "identity", label: "人物" },
      { page: "media-binding", label: "本机素材" },
    ],
  },
  script: {
    label: "剧本",
    defaultPage: "script",
    pages: [
      { page: "script", label: "剧本" },
      { page: "coverage", label: "覆盖" },
    ],
  },
  edit: {
    label: "剪辑",
    defaultPage: "timeline",
    pages: [
      { page: "timeline", label: "剪辑工作台" },
      { page: "delivery", label: "交付" },
    ],
  },
  review: {
    label: "审阅",
    defaultPage: "watch",
    pages: [
      { page: "watch", label: "看片" },
      { page: "attention", label: "待处理" },
      { page: "overview", label: "概览" },
    ],
  },
};

const ALL_PAGES = new Set<ProductionPage>(Object.values(AREAS).flatMap((area) => area.pages.map((item) => item.page)));

function safeProductionPage(page: ProductionPage): ProductionPage {
  const canonical: ProductionPage = page === "rough-cut" || page === "assembly" ? "timeline" : page;
  return ALL_PAGES.has(canonical) ? canonical : "slate";
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

export function ProjectWorkbench({ baseUrl, project, pageRequest = null, onOpenTeamReview, onPageChange }: Props) {
  const [page, setPage] = useState<ProductionPage>(() => safeProductionPage(readProjectPage(project.project_id)));
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);
  const [reviewReturn, setReviewReturn] = useState<ReviewReturnContext | null>(null);
  const [operatorRevision, setOperatorRevision] = useState(0);
  const area = areaForPage(page);
  const areaDefinition = AREAS[area];

  function navigate(next: ProductionPage, options?: { preserveReviewReturn?: boolean }): void {
    const safe = safeProductionPage(next);
    if (!options?.preserveReviewReturn) setReviewReturn(null);
    setPage(safe);
    onPageChange?.(safe);
  }

  function switchArea(next: ProductionArea): void {
    if (next === area) return;
    navigate(AREAS[next].defaultPage);
  }

  useEffect(() => {
    rememberProjectPage(project.project_id, page);
    onPageChange?.(page);
  }, [onPageChange, page, project.project_id]);

  useEffect(() => {
    if (pageRequest) navigate(pageRequest.page);
  }, [pageRequest?.nonce]);

  function openTakeFromEvidence(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    const sourcePage = page;
    setMaterialFocusGroupId(value);
    setReviewReturn(sourcePage === "watch" ? null : { page: sourcePage, label: pageLabel(sourcePage) });
    navigate("watch", { preserveReviewReturn: true });
  }

  function openTakeInPreciseScript(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    setMaterialFocusGroupId(value);
    navigate("script");
  }

  function returnFromReview(): void {
    if (!reviewReturn) return;
    navigate(reviewReturn.page);
  }

  const materialScript = page === "takes" || page === "script";
  const assistantVisible = assistantOpen;
  const canvasKey = `${project.project_id}:${page}:operator-${operatorRevision}`;
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
            <button type="button" className={area === key ? "is-active" : ""} aria-current={area === key ? "page" : undefined} key={key} onClick={() => switchArea(key)}>{definition.label}</button>
          ))}
        </nav>
        <div className="professional-project-tools">
          <CurrentOperatorControl onChange={() => setOperatorRevision((value) => value + 1)} />
          <button type="button" className={`professional-assistant-toggle ${assistantOpen ? "is-active" : ""}`} onClick={() => setAssistantOpen((value) => !value)} aria-pressed={assistantOpen}>小镜</button>
          {onOpenTeamReview ? <button type="button" className="secondary professional-team-review" onClick={onOpenTeamReview}>团队审阅</button> : null}
        </div>
      </header>

      <nav className="professional-secondary-nav" aria-label={`${AREAS[area].label}工作区`}>
        <div className="professional-secondary-pages">
          {page === "watch" && reviewReturn ? (
            <button type="button" className="professional-review-return" onClick={returnFromReview} title={`返回刚才的${reviewReturn.label}工作位置`}>← {reviewReturn.label}</button>
          ) : null}
          {areaDefinition.pages.filter((item) => item.page !== "media-binding").map((item) => (
            <button type="button" className={page === item.page ? "is-active" : ""} aria-current={page === item.page ? "page" : undefined} key={item.page} onClick={() => navigate(item.page)}>{item.label}</button>
          ))}
        </div>
        <span className="professional-page-context">{AREAS[area].label} / {pageLabel(page)}</span>
      </nav>

      <div className="project-workbench-canvas">
        <div className="project-workbench-main owns-chrome" key={canvasKey}>
          {page === "slate" ? (
            <>
              <GoldenSlateWorkbench baseUrl={baseUrl} projectId={project.project_id} />
              <SlatePlaybackShortcuts />
            </>
          ) : null}

          {materialScript ? (
            <GoldenMaterialScriptWorkbench
              baseUrl={baseUrl}
              project={project}
              initialGroupId={materialFocusGroupId}
              phase={page === "takes" ? "rough" : "precise"}
              onOpenPrecise={openTakeInPreciseScript}
              showEditorial={false}
            />
          ) : null}

          {page === "media-library" ? <MediaLibraryWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenMediaBinding={() => navigate("media-binding")} /> : null}
          {page === "media-binding" ? <MediaBindingWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "coverage" ? <CoverageWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "delivery" ? <DeliveryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "watch" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial /> : null}
          {page === "attention" ? <ReviewAttentionWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "overview" ? <ProjectOverviewWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
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
