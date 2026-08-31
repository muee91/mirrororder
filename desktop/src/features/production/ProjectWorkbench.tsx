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
                onOpenMaterialScript={() => setPage("takes")}
                onOpenIdentity={() => setPage("identity")}
                onOpenReview={onOpenTeamReview ?? (() => setPage("watch"))}
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
              onBack={() => setPage("slate")}
            />
          ) : null}

          {secondarySurface ? (
            <section className="production-secondary-workspace">
              <header className="production-secondary-bar">
                <button type="button" className="production-secondary-back" onClick={() => setPage("slate")}>返回场记</button>
                <strong>{project.name || project.project_id}</strong>
                <div className="production-secondary-actions">
                  <label className="production-secondary-switcher">
                    <span className="sr-only">项目工具</span>
                    <select value={page} aria-label="项目工具" onChange={(event) => setPage(event.target.value as ProductionPage)}>
                      {SECONDARY_PAGES.map((item) => <option value={item.value} key={item.value}>{item.label}</option>)}
                    </select>
                  </label>
                  <button type="button" className={assistantVisible ? "is-active" : ""} onClick={() => setAssistantOpen((value) => !value)}>小镜</button>
                </div>
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
