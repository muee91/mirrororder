import type { ProjectSummary, WorkspacePayload } from "../../api/host";
import type { ProjectActivitySummary } from "./projectActivity";
import { projectPresentation } from "./projectPresentation";

interface Props {
  workspace: WorkspacePayload;
  activities?: Record<string, ProjectActivitySummary>;
  onOpenProject: (project: ProjectSummary) => void;
  onOpenProjects: () => void;
  onOpenStatus: () => void;
  onOpenSettings: () => void;
}

export function WorkspaceHome({
  workspace,
  activities = {},
  onOpenProject,
  onOpenProjects,
  onOpenStatus,
  onOpenSettings,
}: Props) {
  const presentations = workspace.projects.map((project) => ({
    project,
    activity: activities[project.project_id],
    presentation: projectPresentation(project, activities[project.project_id]),
  }));
  const activeCount = presentations.filter((item) => item.activity?.state === "active").length;
  const attentionCount = presentations.reduce((sum, item) => sum + item.presentation.attention, 0);
  const readyCount = presentations.filter((item) => item.presentation.statusTone === "ready").length;
  const recent = presentations.slice(0, 4);

  return (
    <section className="workspace-home-canvas">
      <header className="workspace-home-hero">
        <div>
          <p className="eyebrow">制作工作台</p>
          <h1>今晚继续哪里？</h1>
          <p>从项目、场记、素材与后台任务进入同一套制作工作流。</p>
        </div>
        <button type="button" onClick={onOpenProjects}>查看全部项目</button>
      </header>

      <div className="workspace-home-metrics" aria-label="工作区摘要">
        <article><span>项目</span><strong>{workspace.projects.length}</strong><small>当前工作区</small></article>
        <article className={activeCount ? "is-active" : ""}><span>后台处理中</span><strong>{activeCount}</strong><small>{activeCount ? "正在运行" : "当前空闲"}</small></article>
        <article className={attentionCount ? "needs-attention" : ""}><span>待处理</span><strong>{attentionCount}</strong><small>跨项目事项</small></article>
        <article><span>已就绪</span><strong>{readyCount}</strong><small>可直接制作</small></article>
      </div>

      <div className="workspace-home-grid">
        <section className="workspace-home-panel workspace-home-projects">
          <header><div><p className="eyebrow">最近项目</p><h2>继续制作</h2></div><button type="button" className="secondary" onClick={onOpenProjects}>全部项目</button></header>
          {recent.length ? (
            <div className="workspace-home-project-list">
              {recent.map(({ project, activity, presentation }) => (
                <button type="button" key={project.project_id} onClick={() => onOpenProject(project)}>
                  <span className={`workspace-home-project-status status-${presentation.statusTone}`} aria-hidden="true" />
                  <span className="workspace-home-project-copy">
                    <strong>{project.name || project.project_id}</strong>
                    <small>{presentation.kind} · {presentation.sidebarSubtitle}</small>
                  </span>
                  {activity?.state === "active" ? <span className="project-activity-spinner" aria-label="后台处理中" /> : <span className="workspace-home-project-arrow" aria-hidden="true">›</span>}
                </button>
              ))}
            </div>
          ) : (
            <div className="workspace-home-empty"><strong>还没有制作项目</strong><span>进入“项目”创建第一个项目。</span></div>
          )}
        </section>

        <section className="workspace-home-panel workspace-home-system">
          <header><div><p className="eyebrow">系统</p><h2>制作环境</h2></div></header>
          <button type="button" className="workspace-home-system-row" onClick={onOpenStatus}>
            <span><strong>状态中心</strong><small>{activeCount ? `${activeCount} 个后台工作正在运行` : attentionCount ? `${attentionCount} 个事项需要处理` : "后台工作正常"}</small></span>
            <span aria-hidden="true">›</span>
          </button>
          <button type="button" className="workspace-home-system-row" onClick={onOpenSettings}>
            <span><strong>本机智能与设置</strong><small>外观、模型、身份识别与团队服务</small></span>
            <span aria-hidden="true">›</span>
          </button>
          <div className="workspace-home-flow">
            <span>场记</span><i>→</i><span>素材</span><i>→</i><span>人物</span><i>→</i><span>审阅</span>
          </div>
        </section>
      </div>
    </section>
  );
}
