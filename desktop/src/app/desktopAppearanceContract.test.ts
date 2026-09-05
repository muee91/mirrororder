import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Desktop appearance product contract", () => {
  it("initializes before React render and loads explicit overrides after base styles", () => {
    const main = read("../main.tsx");
    expect(main).toContain("initializeDesktopAppearance();");
    expect(main.indexOf('import "./styles.css"')).toBeLessThan(main.indexOf('import "./desktop-theme.css"'));
    expect(main.indexOf('import "./desktop-theme.css"')).toBeLessThan(main.indexOf('import "./desktop-theme-slate.css"'));
    expect(main.indexOf('import "./desktop-theme-slate.css"')).toBeLessThan(main.indexOf('import "./desktop-theme-frozen-surfaces.css"'));
    expect(main).not.toContain("golden-material-script-theme.css");
    expect(main.indexOf("initializeDesktopAppearance();")).toBeLessThan(main.indexOf("createRoot("));
  });

  it("stores only a device-local Desktop preference and always resolves a concrete DOM theme", () => {
    const appearance = read("./desktopAppearance.ts");
    expect(appearance).toContain('"mirrororder.desktop.appearance"');
    expect(appearance).toContain("localStorage");
    expect(appearance).toContain("mirrororderAppearance");
    expect(appearance).toContain("mirrororderTheme = resolved");
    expect(appearance).toContain('"(prefers-color-scheme: dark)"');
    expect(appearance).toContain('addEventListener("change", sync)');
    expect(appearance).not.toContain("workspace");
    expect(appearance).not.toContain("project_id");
    expect(appearance).not.toContain("FrontendSettings");
  });

  it("keeps Desktop appearance independent from Team Web and makes Settings its product home", () => {
    const control = read("../features/settings/DesktopAppearanceControl.tsx");
    const settings = read("../features/settings/SettingsStatusWorkbench.tsx");
    const library = read("../features/projects/ProjectLibrary.tsx");
    expect(control).toContain("Desktop 外观模式");
    expect(control).toContain("跟随系统");
    expect(control).toContain("浅色");
    expect(control).toContain("深色");
    expect(settings).toContain("<DesktopAppearanceControl />");
    expect(settings).toContain("通用");
    expect(library).not.toContain("DesktopAppearanceControl");
    expect(control).not.toContain("TeamWeb");
    expect(control).not.toContain("FrontendSettings");
  });

  it("provides explicit root-prefixed light and dark overrides across current production surfaces", () => {
    const css = read("../desktop-theme.css");
    const tools = read("../desktop-theme-tools.css");
    const material = read("../features/material-script/material-script.css");
    const workspaces = read("../features/production/production-workspaces.css");
    const takeCard = read("../features/material-script/take-card.css");
    const slate = read("../desktop-theme-slate.css");
    const frozen = read("../desktop-theme-frozen-surfaces.css");
    expect(css).toContain('html[data-mirrororder-theme="light"]');
    expect(css).toContain('html[data-mirrororder-theme="dark"]');
    expect(tools).toContain(".settings-status-workbench");
    expect(material).toContain("var(--mo-");
    expect(workspaces).toContain("var(--mo-");
    expect(material).not.toContain("@media (prefers-color-scheme");
    expect(workspaces).not.toContain("@media (prefers-color-scheme");
    expect(takeCard).toContain(".mo-take-list-row");
    expect(takeCard).toContain("var(--mo-");
    expect(takeCard).not.toContain("@media (prefers-color-scheme");
    expect(slate).toContain('html[data-mirrororder-theme="light"] .golden-take-picker');
    expect(slate).toContain('html[data-mirrororder-theme="dark"] .golden-take-picker');
    expect(slate).toContain(".golden-inspector-field textarea");
    expect(slate).toContain('html[data-mirrororder-theme="light"] .golden-slate-actions .icon-action.is-active');
    expect(slate).toContain('html[data-mirrororder-theme="light"] .golden-slate-table input { border-color: transparent;');
    expect(slate).toContain('html[data-mirrororder-theme="dark"] .golden-slate-table input { border-color: transparent;');
    expect(slate).toContain('html[data-mirrororder-theme="light"] button.danger-subtle');
    expect(slate).toContain('html[data-mirrororder-theme="dark"] button.danger-subtle');
    expect(slate).toContain(".golden-inspector-actions .danger-subtle { flex: 0 0 auto;");
    expect(frozen).toContain('html[data-mirrororder-theme="light"] .project-home-heading');
    expect(frozen).toContain('html[data-mirrororder-theme="dark"] .project-home-heading');
    expect(frozen).toContain('html[data-mirrororder-theme="light"] .mo-media-prefer');
    expect(frozen).toContain('html[data-mirrororder-theme="dark"] .mo-media-prefer');
  });
});
