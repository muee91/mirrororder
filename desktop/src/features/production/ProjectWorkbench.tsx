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
import { SemanticSearchPalette } from "../search/SemanticSearchPalette";
import { SettingsStatusWorkbench } from "../settings/SettingsStatusWorkbench";
import "../settings/settings.css";
import { SlateWorkbench } from "../slate/SlateWorkbench";
import "./production.css";
import "./assistant-drawer.css";

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
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);
  const activeArea = areaForPage(page);
  const secondaryPages = useMemo(() => AREAS.find((area) => area.id === activeArea)?.pages ?? [], [activeArea]);

  function openTakeFromEvidence(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    setMaterialFocusGroupId(value);
    setSettingsOpen(false);
    setPage("watch");
  }

  function chooseArea(area: ProductionArea): void {
    setSettingsOpen(false);
    setPage(firstPage(area));
  }

  function choosePage(next: ProductionPage): void {
    setSettingsOpen(false);
    setPage(next);
  }

  return (
    <section className={`project-production-workbench ${assistantOpen ? "has-assistant-drawer" : ""}`}>
      <div className="project-workbench-navigation">
        <nav className="project-workbench-nav project-workbench-primary" aria-label="项目制作区">
          {AREAS.map((area) => (
            <button type="button" className={!settingsOpen && activeArea === area.id ? "is-active" : ""} key={area.id} onClick={() => chooseArea(area.id)}>
              <span>{area.label}</span>
            </button>
          ))}
        </nav>
        <div className="project-workbench-utility" aria-label="项目工具">
          <SemanticSearchPalette baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} />
          <button type="button" className={assistantOpen ? "is-active" : ""} aria-expanded={assistantOpen} onClick={() => setAssistantOpen((value) => !value)}>小镜</button>
          <button type="button" className={settingsOpen ? "is-active" : ""} onClick={() => setSettingsOpen((value) => !value)}>设置</button>
        </div>
      </div>

      {!settingsOpen ? (
        <nav className="project-workbench-secondary" aria-label="当前制作区工具">
          {secondaryPages.map((item) => (
            <button type="button" className={page === item.id ? "is-active" : ""} key={item.id} onClick={() => choosePage(item.id)}>{item.label}</button>
          ))}
        </nav>
      ) : null}

      <div className="project-workbench-canvas">
        <div className="project-workbench-main">
          {settingsOpen ? <SettingsStatusWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

          {!settingsOpen && page === "media-library" ? <MediaLibraryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {!settingsOpen && page === "takes" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial={false} /> : null}
          {!settingsOpen && page === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {!settingsOpen && page === "slate" ? <SlateWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

          {!settingsOpen && page === "script" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="script" showEditorial={false} /> : null}
          {!settingsOpen && page === "coverage" ? <CoverageWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}

          {!settingsOpen && page === "rough-cut" ? <RoughCutWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {!settingsOpen && page === "assembly" ? <AssemblyWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {!settingsOpen && page === "timeline" ? <TimelineWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
          {!settingsOpen && page === "delivery" ? <DeliveryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}

          {!settingsOpen && page === "watch" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial /> : null}
          {!settingsOpen && page === "attention" ? <ReviewAttentionWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
          {!settingsOpen && page === "overview" ? <ProjectOverviewWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
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
