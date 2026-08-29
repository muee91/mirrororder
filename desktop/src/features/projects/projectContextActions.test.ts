import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const library = readFileSync(fileURLToPath(new URL("./ProjectLibrary.tsx", import.meta.url)), "utf8");
const app = readFileSync(fileURLToPath(new URL("../../app/App.tsx", import.meta.url)), "utf8");
const workbench = readFileSync(fileURLToPath(new URL("../production/ProjectWorkbench.tsx", import.meta.url)), "utf8");

describe("sidebar project actions", () => {
  it("restores the high-value project context menu", () => {
    expect(library).toContain("onContextMenu");
    expect(library).toContain("团队审阅");
    expect(library).toContain("本机素材 / 换素材盘");
    expect(library).toContain("重整项目");
    expect(library).toContain("Shift");
    expect(library).toContain('event.key === "F10"');
  });

  it("routes actions through existing Desktop authorities", () => {
    expect(app).toContain("new ProjectActionClient(snapshot.baseUrl).localLocation");
    expect(app).toContain("platform.reveal(location.project_dir)");
    expect(app).toContain("new DesktopClient(snapshot.baseUrl).prepareProject");
    expect(app).toContain('setSurface("status")');
    expect(app).toContain('openProjectPage(project, "media-binding")');
    expect(app).toContain('setSurface("team")');
  });

  it("exposes device media binding as a first-class Production page", () => {
    expect(workbench).toContain('{ id: "media-binding", label: "本机素材" }');
    expect(workbench).toContain('page === "media-binding" ? <MediaBindingWorkbench');
    expect(workbench).toContain("pageRequest?.nonce");
  });
});
