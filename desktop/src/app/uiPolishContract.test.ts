import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Desktop UI polish contract", () => {
  it("does not render placeholder Unicode project icons or a fake text brand mark", () => {
    const library = read("../features/projects/ProjectLibrary.tsx");
    const home = read("../features/projects/ProjectHome.tsx");
    const lifecycle = read("../features/projects/ProjectLifecyclePanel.tsx");

    expect(library).not.toContain("▥");
    expect(library).not.toContain("▰");
    expect(library).not.toContain('aria-hidden="true">镜</span>');
    expect(library).not.toContain(">!</span>");
    expect(library).toContain('import mirrororderLogo from "../../assets/mirrororder-logo.svg"');
    expect(library).toContain('<img className="mirror-mark" src={mirrororderLogo} alt="" aria-hidden="true" />');

    expect(home).not.toContain("▥");
    expect(home).not.toContain("▰");
    expect(home).not.toContain("•••");
    expect(home).not.toContain("project-home-project-icon");
    expect(home).toContain(">更多</button>");
    expect(lifecycle).not.toContain("＋ 新建项目");
  });

  it("bundles the canonical MirrorOrder logo through the Desktop source asset graph", () => {
    const library = read("../features/projects/ProjectLibrary.tsx");
    const logo = read("../assets/mirrororder-logo.svg");
    const canonicalLogo = read("../../../branding/logo.svg");
    const styles = read("../styles.css");
    const projects = read("../features/projects/projects.css");

    expect(library).toContain('import mirrororderLogo from "../../assets/mirrororder-logo.svg"');
    expect(logo).toBe(canonicalLogo);
    expect(styles).not.toContain(".startup-logo::before");
    expect(projects).not.toContain(".mirror-mark::before");
  });

  it("keeps project copy out of the removed three-pixel icon column", () => {
    const projects = read("../features/projects/projects.css");
    const fidelity = read("../features/projects/project-library-fidelity.css");

    expect(projects).toContain(".project-row { display: grid; grid-template-columns: minmax(0, 1fr) auto;");
    expect(projects).not.toContain("grid-template-columns: 3px minmax(0, 1fr) auto");
    expect(projects).not.toContain(".project-row-leading");
    expect(fidelity).toContain(".project-row { grid-template-columns: minmax(0,1fr) auto;");
  });

  it("uses one project presentation model across home and sidebar and keeps status visible at minimum width", () => {
    const home = read("../features/projects/ProjectHome.tsx");
    const library = read("../features/projects/ProjectLibrary.tsx");
    const css = read("../features/projects/project-home.css");

    expect(home).toContain("projectPresentation(project, activity, review)");
    expect(library).toContain("projectPresentation(project, activity)");
    expect(home).not.toContain("function projectStatus(");
    expect(library).not.toContain("function projectSubtitle(");
    expect(css).toContain(".project-home-state.status-idle");
    expect(css).not.toContain(".project-home-state { display: none; }");
  });

  it("keeps navigation out of the toast channel and expires real action feedback", () => {
    const app = read("./App.tsx");

    expect(app).toContain("const NOTICE_DURATION_MS = 3200;");
    expect(app).toContain("const ERROR_NOTICE_DURATION_MS = 7000;");
    expect(app).toContain("const [noticeVisible, setNoticeVisible] = useState(false);");
    expect(app).toContain("globalThis.setTimeout(");
    expect(app).toContain("() => setNoticeVisible(false)");
    expect(app).toContain("{noticeVisible ? (");
    expect(app).not.toContain('setMessage(`已打开 ${project.name');
    expect(app).not.toContain('setMessage(`团队审阅 · ${project.name');
    expect(app).not.toContain('setMessage(`项目主页 · ${snapshot?.projects.length');
  });

  it("uses semantic Slate utility controls instead of placeholder glyphs and pseudo labels", () => {
    const slate = read("../features/slate/GoldenSlateWorkbench.tsx");
    const slateTheme = read("../desktop-theme-slate.css");

    expect(slateTheme).toContain(".golden-slate-mode .slate-mode-icon { display: none; }");
    expect(slate).toContain(">检视</button>");
    expect(slate).toContain(">刷新</button>");
    expect(slate).toContain("aria-pressed={inspectorOpen}");
    expect(slate).not.toContain(">▥</button>");
    expect(slate).not.toContain(">↻</button>");
    expect(slateTheme).not.toContain('content: "检视";');
    expect(slateTheme).not.toContain('content: "刷新";');
  });
});
