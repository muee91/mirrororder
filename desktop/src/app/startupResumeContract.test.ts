import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

describe("startup and production resume product contract", () => {
  it("keeps Host connection details out of the primary startup surface", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).toContain('className={`startup-home');
    expect(source).toContain("继续制作");
    expect(source).toContain("工作区与连接");
    expect(source).toContain("高级连接");
    expect(source).not.toContain('<section className="connection-panel">');
    expect(source).not.toContain("app-workspace-switch");
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
  });

  it("trusts only managed startAndConnect as an automatic workspace resume source", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const connectBlock = source.slice(source.indexOf("async function connect()"), source.indexOf("async function refreshWorkspace"));
    const openBlock = source.slice(source.indexOf("async function openWorkspacePath"), source.indexOf("async function chooseWorkspace"));
    expect(connectBlock).not.toContain("rememberWorkspace(");
    expect(connectBlock).not.toContain("rememberProject(");
    expect(openBlock).toContain("new HostConnection(defaultHostBaseUrl).startAndConnect(normalizedPath)");
    expect(openBlock.indexOf("startAndConnect(normalizedPath)")).toBeLessThan(openBlock.indexOf("rememberWorkspace(normalizedPath)"));
  });

  it("preserves the existing production canvas when a workspace switch fails", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).toContain("const previousSnapshot = snapshot");
    expect(source).toContain("setSnapshot(previousSnapshot)");
    expect(source).toContain("当前工作现场保持打开");
  });

  it("keeps an uncommitted advanced Host address away from active workspace refreshes", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const refreshBlock = source.slice(source.indexOf("async function refreshWorkspace"), source.indexOf("function selectProject"));
    expect(source).toContain("baseUrl and workspacePath are editable advanced-control drafts");
    expect(refreshBlock).toContain("const activeBaseUrl = snapshot?.baseUrl ?? baseUrl");
    expect(refreshBlock).toContain("activeConnection = new HostConnection(activeBaseUrl)");
    expect(refreshBlock).toContain("await activeConnection.connect()");
    expect(refreshBlock).not.toContain("await connection.connect()");
  });

  it("keeps an uncommitted workspace path away from Finder reveal and Team Web", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    expect(source).toContain('const [activeWorkspacePath, setActiveWorkspacePath] = useState("")');
    expect(source).toContain("snapshot.baseUrl and activeWorkspacePath are the active");
    expect(source).toContain("const target = snapshot ? activeWorkspacePath : workspacePath");
    expect(source).toContain("disabled={!isTauri() || !activeWorkspacePath.trim()}");
    expect(source).toContain("<TeamWebWorkbench workspacePath={activeWorkspacePath}");
    expect(source).toContain("setActiveWorkspacePath(launchResume.workspacePath)");
    expect(source).toContain("setActiveWorkspacePath(normalizedPath)");
  });

  it("clears project and local-path context when advanced connection crosses workspace identity", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const connectBlock = source.slice(source.indexOf("async function connect()"), source.indexOf("async function refreshWorkspace"));
    expect(connectBlock).toContain("const sameWorkspace = previousSnapshot?.workspace.workspace_id === next.workspace.workspace_id");
    expect(connectBlock).toContain("const project = sameWorkspace && selectedProject ? projectById(next, selectedProject.project_id) : null");
    expect(connectBlock).toContain('const connectedWorkspacePath = sameWorkspace ? activeWorkspacePath : ""');
    expect(connectBlock).toContain("setSelectedProject(project)");
    expect(connectBlock).toContain("setActiveWorkspacePath(connectedWorkspacePath)");
    expect(connectBlock).toContain("本机路径未知");
  });

  it("keeps the current workspace open when an advanced connection attempt fails", () => {
    const source = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const connectBlock = source.slice(source.indexOf("async function connect()"), source.indexOf("async function refreshWorkspace"));
    expect(connectBlock).toContain("const previousSnapshot = snapshot");
    expect(connectBlock).toContain("setSnapshot(previousSnapshot)");
    expect(connectBlock).toContain("setSelectedProject(previousProject)");
    expect(connectBlock).toContain("setPageRequest(previousPageRequest)");
    expect(connectBlock).toContain("setSurface(previousSurface)");
    expect(connectBlock).toContain('setState("connected")');
    expect(connectBlock).toContain("当前工作现场保持打开");
  });

  it("restores the remembered project context on Workspace Home while opening project production on Slate", () => {
    const app = readFileSync(fileURLToPath(new URL("./App.tsx", import.meta.url)), "utf8");
    const workbench = readFileSync(fileURLToPath(new URL("../features/production/ProjectWorkbench.tsx", import.meta.url)), "utf8");
    const resume = readFileSync(fileURLToPath(new URL("./resumeState.ts", import.meta.url)), "utf8");

    expect(app).toContain("const rememberedProject = projectById(next, launchResume.projectId)");
    expect(app).toContain("setSelectedProject(rememberedProject)");
    expect(app).toContain('setActiveProjectPage("slate")');
    expect(app).toContain('setSurface("home")');
    expect(workbench).toContain('useState<ProductionPage>("slate")');
    expect(workbench).toContain("rememberProjectPage(project.project_id, page)");
    expect(workbench).not.toContain("readProjectPage(project.project_id)");
    expect(workbench).not.toContain('useState<ProductionPage>("takes")');
    expect(resume).toContain('const DEFAULT_PROJECT_PAGE: ProductionPage = "slate"');
  });
});
