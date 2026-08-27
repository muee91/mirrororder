import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("startup and resume product contract", () => {
  it("keeps Host connection details out of the primary startup surface", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).toContain('className={`startup-home');
    expect(source).toContain("打开工作区开始制作");
    expect(source).toContain("工作区与连接");
    expect(source).toContain("高级连接");
    expect(source).toContain("workspace-session-bar");
    expect(source).not.toContain('<section className="connection-panel">');
  });

  it("reuses one startup promise so React StrictMode cannot swallow resume", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).toContain("resumeTaskRef");
    expect(source).toContain("resumeTaskRef.current ?? new HostConnection(defaultHostBaseUrl).startAndConnect");
    expect(source).toContain("resumeTaskRef.current = task");
    expect(source).not.toContain("resumeAttemptedRef");
  });

  it("never treats server array order as the default project", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).not.toContain("next.projects[0]");
    expect(source).toContain("projectById(next, launchResume.projectId)");
    expect(source).toContain("请选择项目继续");
  });

  it("trusts only startAndConnect as an automatic workspace resume source", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const connectBlock = source.slice(source.indexOf("async function connect()"), source.indexOf("async function refreshWorkspace"));
    const openBlock = source.slice(source.indexOf("async function openWorkspacePath"), source.indexOf("async function chooseWorkspace"));
    expect(connectBlock).not.toContain("rememberWorkspace(");
    expect(connectBlock).not.toContain("rememberProject(");
    expect(openBlock).toContain("await connection.startAndConnect(normalizedPath)");
    expect(openBlock.indexOf("await connection.startAndConnect(normalizedPath)")).toBeLessThan(openBlock.indexOf("rememberWorkspace(normalizedPath)"));
  });

  it("preserves the existing product canvas when a workspace switch fails", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).toContain("const previousSnapshot = snapshot");
    expect(source).toContain("setSnapshot(previousSnapshot)");
    expect(source).toContain("当前工作区保持打开");
  });

  it("restores a project page and defaults new projects to the media library", () => {
    const workbench = readFileSync(fileURLToPath(new URL("../features/production/ProjectWorkbench.tsx", import.meta.url)), "utf8");
    const resume = readFileSync(fileURLToPath(new URL("./resumeState.ts", import.meta.url)), "utf8");
    expect(workbench).toContain("readProjectPage(project.project_id)");
    expect(workbench).toContain("rememberProjectPage(project.project_id, next)");
    expect(workbench).not.toContain('useState<ProductionPage>("takes")');
    expect(resume).toContain('const DEFAULT_PROJECT_PAGE: ProductionPage = "media-library"');
  });
});
