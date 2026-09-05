import type { ProjectSummary } from "../../api/host";
import { IdentityWorkbench } from "../identity/IdentityWorkbench";
import { MediaBindingWorkbench } from "../media/MediaBindingWorkbench";
import { MediaLibraryWorkbench } from "../media/MediaLibraryWorkbench";
import { GoldenSlateWorkbench } from "../slate/GoldenSlateWorkbench";
import { SlatePlaybackShortcuts } from "../slate/SlatePlaybackShortcuts";
import { MaterialTakeView } from "./MaterialTakeView";
import "./material-workspace.css";

export type MaterialView = "slate" | "library" | "takes" | "people" | "repair";

interface Props {
  baseUrl: string;
  project: ProjectSummary;
  view: MaterialView;
  initialGroupId?: string | null;
  onViewChange: (view: MaterialView, groupId?: string) => void;
  onOpenScript?: (groupId: string) => void;
  onOpenReview?: (groupId?: string) => void;
  onOpenTimeline?: (groupId: string) => void;
}

const MATERIAL_VIEWS: Array<{ view: Exclude<MaterialView, "repair">; label: string; hint: string }> = [
  { view: "slate", label: "场记", hint: "拍摄事实" },
  { view: "library", label: "素材库", hint: "文件与机位" },
  { view: "takes", label: "Take", hint: "多机位镜次" },
  { view: "people", label: "人物", hint: "人物与角色" },
];

const DEFAULT_VIEW_DEFINITION = { view: "slate", label: "场记", hint: "拍摄事实" } as const;

export function MaterialWorkspace({
  baseUrl,
  project,
  view,
  initialGroupId = null,
  onViewChange,
  onOpenScript,
  onOpenReview,
  onOpenTimeline,
}: Props) {
  const activeView = view === "repair" ? "library" : view;
  const activeDefinition = MATERIAL_VIEWS.find((item) => item.view === activeView) ?? DEFAULT_VIEW_DEFINITION;

  return (
    <section className="material-workspace" data-material-view={view}>
      <header className="material-domain-bar">
        <nav className="material-view-nav" aria-label="素材视图">
          {MATERIAL_VIEWS.map((item) => (
            <button
              type="button"
              className={activeView === item.view ? "is-active" : ""}
              aria-current={activeView === item.view ? "page" : undefined}
              key={item.view}
              onClick={() => onViewChange(item.view)}
            >
              <strong>{item.label}</strong>
              <span>{item.hint}</span>
            </button>
          ))}
        </nav>
        <div className="material-domain-context">
          {view === "repair" ? (
            <>
              <span>素材库工具</span>
              <button type="button" className="secondary" onClick={() => onViewChange("library")}>返回素材库</button>
            </>
          ) : (
            <>
              <span>素材 / {activeDefinition.label}</span>
              <small>{activeDefinition.hint}</small>
            </>
          )}
        </div>
      </header>

      <div className="material-view-canvas">
        {view === "slate" ? (
          <>
            <GoldenSlateWorkbench
              baseUrl={baseUrl}
              projectId={project.project_id}
              onOpenMaterialScript={() => onViewChange("takes")}
              onOpenIdentity={() => onViewChange("people")}
              onOpenReview={() => onOpenReview?.()}
            />
            <SlatePlaybackShortcuts />
          </>
        ) : null}

        {view === "library" ? (
          <MediaLibraryWorkbench
            baseUrl={baseUrl}
            projectId={project.project_id}
            onOpenMediaBinding={() => onViewChange("repair")}
          />
        ) : null}

        {view === "takes" ? (
          <MaterialTakeView
            baseUrl={baseUrl}
            project={project}
            initialGroupId={initialGroupId}
            onOpenScript={onOpenScript}
            onOpenReview={(groupId) => onOpenReview?.(groupId)}
            onOpenTimeline={onOpenTimeline}
            onOpenRepair={() => onViewChange("repair")}
          />
        ) : null}

        {view === "people" ? (
          <IdentityWorkbench
            baseUrl={baseUrl}
            projectId={project.project_id}
            onOpenTake={(groupId) => onViewChange("takes", groupId)}
          />
        ) : null}

        {view === "repair" ? (
          <section className="material-repair-view" aria-label="素材恢复工具">
            <div className="material-repair-banner">
              <div>
                <strong>本机素材恢复</strong>
                <span>这里只修复当前设备的素材绑定与扫描，不改变共享拍摄事实。</span>
              </div>
              <button type="button" className="secondary" onClick={() => onViewChange("library")}>返回素材库</button>
            </div>
            <MediaBindingWorkbench baseUrl={baseUrl} projectId={project.project_id} />
          </section>
        ) : null}
      </div>
    </section>
  );
}
