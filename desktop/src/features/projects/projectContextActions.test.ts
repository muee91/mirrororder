import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const library = readFileSync(fileURLToPath(new URL("./ProjectLibrary.tsx", import.meta.url)), "utf8");
const home = readFileSync(fileURLToPath(new URL("./ProjectHome.tsx", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../../app/App.tsx", import.meta.url)), "utf8");
const workbench = readFileSync(fileURLToPath(new URL("../production/ProjectWorkbench.tsx", import.meta.url)), "utf8");

describe("project actions", () => {
  it("keeps the full high-value project context menu in the Swift-style sidebar", () => {
    expect(library).toContain("onContextMenu");
    expect(library).toContain("团队审阅");
    expect(library).toContain("本机素材 / 换素材盘");
    expect(library).toContain("重整项目");
    expect(library).toContain("event.shiftKey");
    expect(library).toContain('event.key === "F10"');
    expect(library).not.toContain('>团队审阅</span><small>');
  });

  it("restores direct card actions on Project Home without a second authority", () => {
    expect(home).toContain("onContextMenu");
    expect(home).toContain("在 Finder / Explorer 中显示");
    expect(home).toContain("开始 / 重新整理");
    expect(home).toContain("projectActions.localLocation");
    expect(home).toContain("platform.reveal(location.project_dir)");
    expect(home).toContain("desktop.prepareProject(project.project_id)");
  });

  it("routes the complete sidebar actions through existing Desktop authorities", () => {
    expect(app).toContain("new ProjectActionClient(snapshot.baseUrl).localLocation");
    expect(app).toContain("platform.reveal(location.project_dir)");
    expect(app).toContain("new DesktopClient(snapshot.baseUrl).prepareProject");
    expect(app).toContain('setSurface("status")');
    expect(app).toContain('openProjectPage(project, "media-binding")');
    expect(app).toContain('setSurface("team")');
  });

  it("keeps device media binding reachable without restoring duplicate Production navigation", () => {
    expect(workbench).toContain('"media-binding"');
    expect(workbench).toContain('page === "media-binding" ? <MediaBindingWorkbench');
    expect(workbench).toContain("pageRequest?.nonce");
    expect(workbench).not.toContain("project-workbench-primary");
  });
});
