import { useEffect, useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { readProjectPage, rememberProjectPage, type ProductionPage } from "../../app/resumeState";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { DeliveryWorkbench } from "../delivery/DeliveryWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import "../editor/timeline.css";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { GoldenMaterialScriptWorkbench } from "../material-script/GoldenMaterialScriptWorkbench";
import { MaterialScriptWorkbench } from "../material-script/MaterialScriptWorkbench";
import "../material-script/material-script.css";
import { MediaBindingWorkbench } from "../media/MediaBindingWorkbench";
import { MediaLibraryWorkbench } from "../media/MediaLibraryWorkbench";
import "../media/media.css";
import { AssemblyWorkbench, CoverageWorkbench, RoughCutWorkbench } from "../planning/PlanningWorkbenches";
import { ProjectOverviewWorkbench, ReviewAttentionWorkbench } from "../review/ReviewWorkbenches";
import { SemanticSearchPalette } from "../search/SemanticSearchPalette";
import { GoldenSlateWorkbench } from "../slate/GoldenSlateWorkbench";
import { SlatePlaybackShortcuts } from "../slate/SlatePlaybackShortcuts";
import "../slate/slate-playback-shortcuts.css";
import "./production.css";
import "./assistant-drawer.css";
import "./product-experience.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
}

type ProductionArea = "material" | "script" | "edit" | "review";
interface PageDefinition { id: ProductionPage; label: string }
interface AreaDefinition { id: ProductionArea; label: string; pages: PageDefinition[] }

const AREAS: AreaDefinition[] = [
  { id: "material", label: "素材", pages: [{ id: "slate", label: "场记" }, { id: "media-library", label: "素材库" }, { id: "media-binding", label: "本机素材" }, { id: "takes", label: "Take" }, { id: "identity", label: "人物" }] },
  { id: "script", label: "剧本", pages: [{ id: "script", label: "剧本" }, { id: "coverage", label: "覆盖" }] },
  { id: "edit", label: "剪辑", pages: [{ id: "rough-cut", label: "粗剪" }, { id: "assembly", label: "组接" }, { id: "timeline", label: "时间线" }, { id: "delivery", label: "交付" }] },
  { id: "review", label: "审阅", pages: [{ id: "watch", label: "看片" }, { id: "attention", label: "待处理" }, { id: "overview", label: "概览" }] },
];

function areaForPage(page: ProductionPage): ProductionArea {
  return AREAS.find((area) => area.pages.some((item) => item.id === page))?.id ?? "material";
}

function firstPage(area: ProductionArea): ProductionPage {
  return AREAS.find((item) => item.id === area)?.pages[0]?.id ?? "slate";
}

export function ProjectWorkbench({ baseUrl, project, pageRequest = null }: Props) {
  const [page, setPage] = useState<ProductionPage>(() => readProjectPage(project.project_id));
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);
  const activeArea = areaForPage(page);
  const secondaryPages = useMemo(() => AREAS.find((area) => area.id === activeArea)?.pages ?? [], [activeArea]);

  useEffect(() => {
    rememberProjectPage(project.project_id, page);
  }, [page, project.project_id]);

  useEffect(() => {
    if (pageRequest) setPage(pageRequest.page);
  }, [pageRequest?.nonce]);

  function openTakeFromEvidence(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    setMaterialFocusGroupId(value);
    setPage("watch");
  }

  function chooseArea(area: ProductionArea): void {
    setPage(firstPage(area));
  }

  function choosePage(next: ProductionPage): void {
    setPage(next);
  }

  return (
    <section className={`project-production-workbench ${assistantOpen ? "has-assistant-drawer" : ""}`}>
      <header className="project-toolbar">
        <div className="project-toolbar-main">
          <div className="project-identity">
            <p className="eyebrow">Production</p>
            <h1>{project.name || project.project_id}</h1>
          </div>
          <nav className="project-workbench-nav project-workbench-primary" aria-label="项目制作区">
            {AREAS.map((area) => (
              <button type="button" className={activeArea === area.id ? "is-active" : ""} key={area.id} onClick={() => chooseArea(area.id)}>
                {area.label}
              </button>
            ))}
          </nav>
          <div className="project-workbench-utility" aria-label="项目工具">
            <SemanticSearchPalette baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} />
            <button type="button" className={assistantOpen ? "is-active" : ""} aria-expanded={assistantOpen} onClick={() => setAssistantOpen((value) => !value)}>小镜</button>
          </div>
        </div>
        <nav className="project-workbench-secondary" aria-label="当前制作区工具">
          {secondaryPages.map((item) => (
            <button type="button" className={page === item.id ? "is-active" : ""} key={item.id} onClick={() => choosePage(item.id)}>{item.label}</button>
          ))}
        </nav>
      </header>

      <div className="project-workbench-canvas">
        <div className="project-workbench-main">
          {page === "media-library" ? <MediaLibraryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "media-binding" ? <MediaBindingWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "takes" ? <GoldenMaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialMode="rough" showEditorial={false} /> : null}
          {page === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "slate" ? <><GoldenSlateWorkbench baseUrl={baseUrl} projectId={project.project_id} /><SlatePlaybackShortcuts /></> : null}
          {page === "script" ? <GoldenMaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialMode="precise" showEditorial={false} /> : null}
          {page === "coverage" ? <CoverageWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "rough-cut" ? <RoughCutWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "assembly" ? <AssemblyWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "delivery" ? <DeliveryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {page === "watch" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial /> : null}
          {page === "attention" ? <ReviewAttentionWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {page === "overview" ? <ProjectOverviewWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
        </div>

        {assistantOpen ? (
          <aside className="assistant-context-drawer" aria-label="小镜上下文助手">
            <div className="assistant-drawer-heading">
              <div><p className="eyebrow">当前项目</p><strong>小镜</strong></div>
              <button type="button" className="secondary" onClick={() => setAssistantOpen(false)} aria-label="关闭小镜">关闭</button>
            </div>
            <AssistantWorkbench baseUrl={baseUrl} projectId={project.project_id} />
          </aside>
        ) : null}
      </div>
    </section>
  );
}
