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

    expect(library).not.toContain("▥");
    expect(library).not.toContain("▰");
    expect(library).not.toContain('aria-hidden="true">镜</span>');
    expect(library).toContain('<span className="mirror-mark" aria-hidden="true" />');

    expect(home).not.toContain("▥");
    expect(home).not.toContain("▰");
    expect(home).not.toContain("project-home-project-icon");
  });

  it("reuses the packaged app icon inside the Desktop UI instead of inventing another logo", () => {
    const frozen = read("../desktop-theme-frozen-surfaces.css");
    const styles = read("../styles.css");
    const projects = read("../features/projects/projects.css");

    expect(frozen).toContain('background-image: url("../src-tauri/icons/icon.png")');
    expect(styles).not.toContain(".startup-logo::before");
    expect(projects).not.toContain(".mirror-mark::before");
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

  it("does not expose placeholder Slate glyphs in the frozen toolbar", () => {
    const slateTheme = read("../desktop-theme-slate.css");

    expect(slateTheme).toContain(".golden-slate-mode .slate-mode-icon { display: none; }");
    expect(slateTheme).toContain('content: "检视";');
    expect(slateTheme).toContain('content: "刷新";');
  });
});
