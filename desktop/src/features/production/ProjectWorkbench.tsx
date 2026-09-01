import { useEffect, useState } from "react";
import type { ProjectSummary } from "../../api/host";
import { rememberProjectPage, type ProductionPage } from "../../app/resumeState";
import { AssistantWorkbench } from "../assistant/AssistantWorkbench";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { GoldenMaterialScriptWorkbench } from "../material-script/GoldenMaterialScriptWorkbench";
import { MaterialScriptWorkbench } from "../material-script/MaterialScriptWorkbench";
import "../material-script/material-script.css";
import { MediaBindingWorkbench } from "../media/MediaBindingWorkbench";
import { MediaLibraryWorkbench } from "../media/MediaLibraryWorkbench";
import "../media/media.css";
import { ProjectOverviewWorkbench, ReviewAttentionWorkbench } from "../review/ReviewWorkbenches";
import { GoldenSlateWorkbench } from "../slate/GoldenSlateWorkbench";
import { SlatePlaybackShortcuts } from "../slate/SlatePlaybackShortcuts";
import "./production.css";
import "./assistant-drawer.css";
import "./product-experience.css";
import "./secondary-tools-theme.css";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  onOpenTeamReview?: () => void;
  onPageChange?: (page: ProductionPage) => void;
}

const PRODUCTION_PAGES = new Set<ProductionPage>([
  "slate",
  "takes",
  "script",
  "media-library",
  "media-binding",
  "identity",
  "watch",
  "attention",
  "overview",
]);

const SECONDARY_PAGES: Array<{ value: ProductionPage; label: string }> = [
  { value: "media-library", label: "素材库" },
  { value: "media-binding", label: "本机素材" },
  { value: "identity", label: "人物" },
  { value: "watch", label: "审阅" },
  { value: "attention", label: "待处理" },
  { value: "overview", label: "概览" },
];

function safeProductionPage(page: ProductionPage): ProductionPage {
  return PRODUCTION_PAGES.has(page) ? page : "slate";
}

function pageLabel(page: ProductionPage): string {
  return SECONDARY_PAGES.find((item) => item.value === page)?.label ?? (page === "takes" ? "Take" : page === "script" ? "剧本" : "场记");
}

export function ProjectWorkbench({ baseUrl, project, pageRequest = null, onOpenTeamReview, onPageChange }: Props) {
  const [page, setPage] = useState<ProductionPage>("slate");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);

  function navigate(next: ProductionPage): void {
    const safe = safeProductionPage(next);
    setPage(safe);
    onPageChange?.(safe);
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
    setMaterialFocusGroupId(value);
    navigate("watch");
  }

  const materialScript = page === "takes" || page === "script";
  const secondarySurface = !materialScript && page !== "slate";
  const slateAssistantVisible = assistantOpen && page === "slate";
  const assistantVisible = assistantOpen && (secondarySurface || page === "slate");

  return (
    <section className={`project-production-workbench ${assistantVisible ? "has-assistant-drawer" : ""} ${slateAssistantVisible ? "has-slate-assistant" : ""}`}>
      <div className="project-workbench-canvas">
        <div className="project-workbench-main owns-chrome">
          {page === "slate" ? (
            <>
              <GoldenSlateWorkbench
                baseUrl={baseUrl}
                projectId={project.project_id}
                assistantOpen={slateAssistantVisible}
                onToggleAssistant={() => setAssistantOpen((value) => !value)}
                onOpenMaterialScript={() => navigate("takes")}
                onOpenIdentity={() => navigate("identity")}
                onOpenReview={onOpenTeamReview ?? (() => navigate("watch"))}
              />
              <SlatePlaybackShortcuts />
            </>
          ) : null}

          {materialScript ? (
            <GoldenMaterialScriptWorkbench
              baseUrl={baseUrl}
              project={project}
              initialGroupId={materialFocusGroupId}
              initialMode={page === "takes" ? "rough" : "precise"}
              showEditorial={false}
              onBack={() => navigate("slate")}
            />
          ) : null}

          {secondarySurface ? (
            <section className="production-secondary-workspace">
              <header className="production-secondary-bar production-secondary-bar-redesign">
                <div className="production-secondary-title">
                  <p className="eyebrow">{project.name || project.project_id}</p>
                  <strong>{pageLabel(page)}</strong>
                </div>
                <nav className="production-secondary-tabs" aria-label="项目工具">
                  <button type="button" onClick={() => navigate("slate")}>场记</button>
                  {SECONDARY_PAGES.map((item) => <button type="button" className={page === item.value ? "is-active" : ""} key={item.value} onClick={() => navigate(item.value)}>{item.label}</button>)}
                </nav>
                <button type="button" className={`production-secondary-assistant ${assistantVisible ? "is-active" : ""}`} onClick={() => setAssistantOpen((value) => !value)}>小镜</button>
              </header>
              <div className="production-secondary-canvas">
                {page === "media-library" ? <MediaLibraryWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenMediaBinding={() => navigate("media-binding")} /> : null}
                {page === "media-binding" ? <MediaBindingWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
                {page === "identity" ? <IdentityWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
                {page === "watch" ? <MaterialScriptWorkbench baseUrl={baseUrl} project={project} initialGroupId={materialFocusGroupId} initialTab="material" showEditorial /> : null}
                {page === "attention" ? <ReviewAttentionWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
                {page === "overview" ? <ProjectOverviewWorkbench baseUrl={baseUrl} projectId={project.project_id} onOpenTake={openTakeFromEvidence} /> : null}
              </div>
            </section>
          ) : null}
        </div>

        {assistantVisible ? (
          <aside className={`assistant-context-drawer ${slateAssistantVisible ? "slate-assistant-drawer" : ""}`} aria-label="小镜上下文助手">
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
