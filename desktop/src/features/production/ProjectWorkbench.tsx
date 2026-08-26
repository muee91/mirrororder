import { useMemo, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { DeliveryWorkbench } from "../delivery/DeliveryWorkbench";
import { TimelineWorkbench } from "../editor/TimelineWorkbench";
import "../editor/timeline.css";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { MaterialScriptWorkbench } from "../material-script/MaterialScriptWorkbench";
import "../material-script/material-script.css";
import { MediaLibraryWorkbench } from "../media/MediaLibraryWorkbench";
import "../media/media.css";
import { AssemblyWorkbench, CoverageWorkbench, RoughCutWorkbench } from "../planning/PlanningWorkbenches";
import { ProjectOverviewWorkbench, ReviewAttentionWorkbench } from "../review/ReviewWorkbenches";
import { SettingsStatusWorkbench } from "../settings/SettingsStatusWorkbench";
import "../settings/settings.css";
import { SlateWorkbench } from "../slate/SlateWorkbench";
import "./production.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
}

type ProductionArea = "material" | "script" | "edit" | "review";
type ProductionPage =
  | "media-library"
  | "takes"
  | "identity"
  | "slate"
  | "script"
  | "coverage"
  | "rough-cut"
  | "assembly"
  | "timeline"
  | "delivery"
  | "watch"
  | "attention"
  | "overview";
type UtilityPage = "assistant" | "settings";

interface PageDefinition {
  id: ProductionPage;
  label: string;
}

interface AreaDefinition {
  id: ProductionArea;
  label: string;
  pages: PageDefinition[];
}

const AREAS: AreaDefinition[] = [
  {
    id: "material",
    label: "素材",
    pages: [
      { id: "media-library", label: "素材库" },
      { id: "takes", label: "Take" },
      { id: "identity", label: "人物" },
      { id: "slate", label: "场记" },
    ],
  },
  {
    id: "script",
    label: "剧本",
    pages: [
      { id: "script", label: "剧本" },
      { id: "coverage", label: "覆盖" },
    ],
  },
  {
    id: "edit",
    label: "剪辑",
    pages: [
      { id: "rough-cut", label: "粗剪" },
      { id: "assembly", label: "组接" },
      { id: "timeline", label: "时间线" },
      { id: "delivery", label: "交付" },
    ],
  },
  {
    id: "review",
    label: "审阅",
    pages: [
      { id: "watch", label: "看片" },
      { id: "attention", label: "待处理" },
      { id: "overview", label: "概览" },
    ],
  },
];

function areaForPage(page: ProductionPage): ProductionArea {
  return AREAS.find((area) => area.pages.some((item) => item.id === page))?.id ?? "material";
}

function firstPage(area: ProductionArea): ProductionPage {
  return AREAS.find((item) => item.id === area)?.pages[0]?.id ?? "takes";
}

export function ProjectWorkbench({ baseUrl, project }: Props) {
  const [page, setPage] = useState<ProductionPage>("takes");
  const [utility, setUtility] = useState<UtilityPage | null>(null);
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);
  const activeArea = areaForPage(page);
  const secondaryPages = useMemo(() => AREAS.find((area) => area.id === activeArea)?.pages ?? [], [activeArea]);

  function openTakeFromEvidence(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    setMaterialFocusGroupId(value);
    setUtility(null);
    setPage("watch");
  }

  function chooseArea(area: ProductionArea): void {
    setUtility(null);
    setPage(firstPage(area));
  }

  function choosePage(next: ProductionPage): void {
    setUtility(null);
    setPage(next);
  }

  function openUtility(next: UtilityPage): void {
    setUtility((current) => current === next ? null : next);
  }

  return (
    <section className="project-production-workbench">
      <div className="project-workbench-navigation">
        <nav className="project-workbench-nav project-workbench-primary" aria-label="项目制作区">
          {AREAS.map((area) => (
            <button type="button" className={!utility && activeArea === area.id ? "is-active" : ""} key={area.id} onClick={() => chooseArea(area.id)}>
              <span>{area.label}</span>
            </button>
          ))}
        </nav>
        <div className="project-workbench-utility" aria-label="项目工具">
          <button type="button" className={utility === "assistant" ? "is-active" : ""} onClick={() => openUtility("assistant")}>小镜</button>
          <button type="button" className={utility === "settings" ? "is-active" : ""} onClick={() => openUtility("settings")}>设置 / 状态</button>
        </div>
      </div>

      {!utility ? (
        <nav className="project-workbench-secondary" aria-label="当前制作区工具">
          {secondaryPages.map((item) => (
            <button type="button" className={page === item.id ? "is-active" : ""} key={item.id} onClick={() => choosePage(item.id)}>{item.label}</button>
          ))}
        </nav>
      ) : null}

      {utility === "assistant" ? <AssistantWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {utility === "settings" ? <SettingsStatusWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

      {!utility && page === "media-library" ? <MediaLibraryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {!utility && page === "takes" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial={false} /> : null}
      {!utility && page === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
      {!utility && page === "slate" ? <SlateWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

      {!utility && page === "script" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="script" showEditorial={false} /> : null}
      {!utility && page === "coverage" ? <CoverageWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}

      {!utility && page === "rough-cut" ? <RoughCutWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
      {!utility && page === "assembly" ? <AssemblyWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
      {!utility && page === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
      {!utility && page === "delivery" ? <DeliveryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

      {!utility && page === "watch" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial /> : null}
      {!utility && page === "attention" ? <ReviewAttentionWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
      {!utility && page === "overview" ? <ProjectOverviewWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
    </section>
  );
}
