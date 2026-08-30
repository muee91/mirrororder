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

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  pageRequest?: { page: ProductionPage; nonce: number } | null;
  onOpenTeamReview?: () => void;
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

function safeProductionPage(page: ProductionPage): ProductionPage {
  return PRODUCTION_PAGES.has(page) ? page : "slate";
}

export function ProjectWorkbench({ baseUrl, project, pageRequest = null, onOpenTeamReview }: Props) {
  const [page, setPage] = useState<ProductionPage>("slate");
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [materialFocusGroupId, setMaterialFocusGroupId] = useState<string | null>(null);

  useEffect(() => {
    rememberProjectPage(project.project_id, page);
  }, [page, project.project_id]);

  useEffect(() => {
    if (pageRequest) setPage(safeProductionPage(pageRequest.page));
  }, [pageRequest?.nonce]);

  function openTakeFromEvidence(groupId: string): void {
    const value = groupId.trim();
    if (!value) return;
    setMaterialFocusGroupId(value);
    setPage("watch");
  }

  const materialScript = page === "takes" || page === "script";
  const secondarySurface = !materialScript && page !== "slate";
  const assistantVisible = assistantOpen && secondarySurface;

  return (
    <section className={`project-production-workbench ${assistantVisible ? "has-assistant-drawer" : ""}`}>
      <div className="project-workbench-canvas">
        <div className={`project-workbench-main ${page === "slate" || materialScript ? "owns-chrome" : ""}`}>
          {page === "slate" ? (
            <>
              <GoldenSlateWorkbench
                baseUrl={baseUrl}
                projectId={project.project_id}
                onOpenMaterialScript={() => setPage("takes")}
                onOpenIdentity={() => setPage("identity")}
                onOpenReview={() => setPage("watch")}
                onOpenTeamReview={onOpenTeamReview}
              />
              <SlatePlaybackShortcuts />
            </>
          ) : null}

          {materialScript ? (
            <section className="golden-secondary-workspace">
              <header className="golden-secondary-return">
                <button type="button" className="secondary" onClick={() => setPage("slate")}>‹ 返回多机位场记</button>
                <span>{project.name || project.project_id}</span>
                <small>素材 / 剧本</small>
              </header>
              <GoldenMaterialScriptWorkbench
                baseUrl={baseUrl}
                project={project}
                initialGroupId={materialFocusGroupId}
                initialMode={page === "takes" ? "rough" : "precise"}
                showEditorial={false}
              />
            </section>
          ) : null}

          {secondarySurface ? (
            <section className="production-secondary-workspace">
              <header className="production-secondary-bar">
                <button type="button" className="secondary" onClick={() => setPage("slate")}>‹ 返回场记</button>
                <strong>{project.name || project.project_id}</strong>
                <nav aria-label="制作辅助工作区">
                  <button type="button" className={page === "media-library" ? "is-active" : ""} onClick={() => setPage("media-library")}>素材库</button>
                  <button type="button" className={page === "media-binding" ? "is-active" : ""} onClick={() => setPage("media-binding")}>本机素材</button>
                  <button type="button" className={page === "identity" ? "is-active" : ""} onClick={() => setPage("identity")}>人物</button>
                  <button type="button" className={page === "watch" ? "is-active" : ""} onClick={() => setPage("watch")}>审阅</button>
                  <button type="button" className={page === "attention" ? "is-active" : ""} onClick={() => setPage("attention")}>待处理</button>
                  <button type="button" className={page === "overview" ? "is-active" : ""} onClick={() => setPage("overview")}>概览</button>
                  <button type="button" className={assistantVisible ? "is-active" : ""} onClick={() => setAssistantOpen((value) => !value)}>小镜</button>
                </nav>
              </header>
              <div className="production-secondary-canvas">
                {page === "media-library" ? <MediaLibraryWorkbench baseUrl={baseUrl} projectId={project.project_id} /> : null}
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
