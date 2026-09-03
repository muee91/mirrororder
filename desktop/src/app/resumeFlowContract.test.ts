import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("editor-first resume flow", () => {
  it("returns a remembered project directly to its last production page", () => {
    const app = read("./App.tsx");

    expect(app).toContain("readProjectPage");
    expect(app).toContain('const rememberedPage = rememberedProject ? readProjectPage(rememberedProject.project_id) : "slate";');
    expect(app).toContain('setActiveProjectPage(rememberedPage);');
    expect(app).toContain('setSurface(rememberedProject ? "production" : "projects");');
  });

  it("uses the project picker as the fallback after opening an unremembered workspace", () => {
    const app = read("./App.tsx");

    expect(app).toContain('setSurface("projects");');
    expect(app).toContain('setSurface(sameWorkspace ? previousSurface : "projects");');
    expect(app).toContain('打开工作区后选择项目继续制作。');
  });

  it("restores each project to its own last page when switching projects", () => {
    const app = read("./App.tsx");

    expect(app).toContain('setActiveProjectPage(readProjectPage(project.project_id));');
  });
});
