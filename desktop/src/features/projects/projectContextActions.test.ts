import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const library = readFileSync(fileURLToPath(new URL("./ProjectLibrary.tsx", import.meta.url)), "utf8");
const home = readFileSync(fileURLToPath(new URL("./ProjectHome.tsx", import.meta.url)), "utf8");
const activity = readFileSync(fileURLToPath(new URL("./projectActivity.ts", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../../app/App.tsx", import.meta.url)), "utf8");
const workbench = readFileSync(fileURLToPath(new URL("../production/ProjectWorkbench.tsx", import.meta.url)), "utf8");

describe("project actions", () => {
  it("keeps the full high-value project context menu in the Swift-style sidebar", () => {
    expect(library).toContain("onContextMenu");
    expect(library).toContain("团队审阅");
    expect(library).toContain("复制局域网协作链接");
    expect(library).toContain("本机素材 / 换素材盘");
    expect(library).toContain("重新整理项目");
    expect(library).toContain("永久删除项目…");
    expect(library).toContain("event.shiftKey");
    expect(library).toContain('event.key === "F10"');
    expect(library).not.toContain('>团队审阅</span><small>');
  });

  it("keeps Project Home management actions explicit and on existing app authority", () => {
    expect(home).toContain("project-home-more");
    expect(home).toContain('aria-haspopup="menu"');
    expect(home).toContain("onContextMenu");
    expect(home).toContain("团队审阅");
    expect(home).toContain("复制局域网协作链接");
    expect(home).toContain("本机素材 / 换素材盘");
    expect(home).toContain("重新整理项目");
    expect(home).toContain("永久删除项目…");
    expect(home).toContain("onOpenTeamProject");
    expect(home).toContain("onCopyShareLink");
    expect(home).toContain("onRevealProject");
    expect(home).toContain("onPrepareProject");
    expect(home).toContain("onOpenMediaBinding");
    expect(home).toContain("onDeleteProject");
    expect(home).not.toContain("new ProjectActionClient");
    expect(home).not.toContain("new PlatformClient");
    expect(home).not.toContain("new DesktopClient");
  });

  it("routes Project Home and sidebar actions through existing Desktop authorities", () => {
    expect(app).toContain("new ProjectActionClient(snapshot.baseUrl).localLocation");
    expect(app).toContain("platform.reveal(location.project_dir)");
    expect(app).toContain("new DesktopClient(snapshot.baseUrl).prepareProject");
    expect(app).toContain("new DesktopClient(snapshot.baseUrl).deleteProject");
    expect(app).toContain("teamGateway.status()");
    expect(app).toContain("teamWorkbenchUrl(status, snapshot.workspace.workspace_id, project.project_id)");
    expect(app).toContain("navigator.clipboard.writeText(shareUrl)");
    expect(app).toContain('openProjectPage(project, "media-binding")');
    expect(app).toContain('setSurface("team")');
    expect(app).toContain("onOpenTeamProject={openTeamProject}");
    expect(app).toContain("onCopyShareLink={(project) => copyProjectShareLink(project)}");
    expect(app).toContain("onDeleteProject={(project) => deleteProject(project)}");
    expect(app).not.toContain("已提交重整任务${task.task_id ? ` · ${task.task_id}` : \"\"}；在状态中心查看进度。");
  });

  it("projects task activity into Home and Sidebar without creating another backend", () => {
    expect(activity).toContain("new ProjectTaskClient(baseUrl)");
    expect(activity).toContain('state: "active"');
    expect(activity).toContain('state: "failed"');
    expect(home).toContain("project-activity-spinner");
    expect(library).toContain("project-activity-spinner");
    expect(home).not.toContain("ProjectTaskClient");
    expect(library).not.toContain("ProjectTaskClient");
  });

  it("keeps device media binding reachable without restoring duplicate Production navigation", () => {
    expect(workbench).toContain('"media-binding"');
    expect(workbench).toContain('page === "media-binding" ? <MediaBindingWorkbench');
    expect(workbench).toContain("pageRequest?.nonce");
    expect(workbench).not.toContain("project-workbench-primary");
  });
});
