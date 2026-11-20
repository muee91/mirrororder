import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("editor-first resume flow", () => {
  it("returns a remembered project directly to its last production page", () => {
    const app = read("./App.tsx");
    const workbench = read("../features/production/ProjectWorkbench.tsx");

    expect(app).toContain("readProjectPage");
    expect(app).toContain('const rememberedPage = rememberedProject ? readProjectPage(rememberedProject.project_id) : "slate";');
    expect(workbench).toContain("safeProductionPage(readProjectPage(project.project_id))");
    expect(app).toContain('setSurface(rememberedProject ? "production" : "projects");');
  });

  it("uses the project picker as the fallback after opening an unremembered workspace", () => {
    const app = read("./App.tsx");
    const launcher = read("../features/projects/WorkspaceLauncher.tsx");

    expect(app).toContain('setSurface("projects");');
    expect(app).toContain('setSurface(sameWorkspace ? previousSurface : "projects");');
    expect(launcher).toContain("onChooseWorkspace(true)");
  });

  it("restores each project to its own last page when switching projects", () => {
    const app = read("./App.tsx");
    const workbench = read("../features/production/ProjectWorkbench.tsx");

    expect(app).toContain('key={`${snapshot.workspace.workspace_id}:${selectedProject.project_id}`}');
    expect(workbench).toContain("rememberProjectPage(project.project_id, page)");
  });
});
