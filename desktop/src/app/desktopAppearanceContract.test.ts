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
    expect(main.indexOf("initializeDesktopAppearance();")).toBeLessThan(main.indexOf("createRoot("));
  });

  it("stores only a device-local Desktop preference", () => {
    const appearance = read("./desktopAppearance.ts");
    expect(appearance).toContain('"mirrororder.desktop.appearance"');
    expect(appearance).toContain("localStorage");
    expect(appearance).toContain("mirrororderTheme");
    expect(appearance).not.toContain("workspace");
    expect(appearance).not.toContain("project_id");
    expect(appearance).not.toContain("FrontendSettings");
  });

  it("keeps Desktop appearance independent from Team Web theme settings", () => {
    const control = read("../features/settings/DesktopAppearanceControl.tsx");
    const library = read("../features/projects/ProjectLibrary.tsx");
    expect(control).toContain("Desktop 外观模式");
    expect(control).toContain("系统");
    expect(control).toContain("浅色");
    expect(control).toContain("深色");
    expect(library).toContain("<DesktopAppearanceControl />");
    expect(control).not.toContain("TeamWeb");
    expect(control).not.toContain("FrontendSettings");
  });

  it("provides explicit root-prefixed light and dark overrides", () => {
    const css = read("../desktop-theme.css");
    expect(css).toContain('html[data-mirrororder-theme="light"]');
    expect(css).toContain('html[data-mirrororder-theme="dark"]');
    expect(css).toContain(".golden-slate-workbench");
    expect(css).toContain(".mo-media-card");
    expect(css).toContain(".project-home-card");
    expect(css).toContain(".take-card");
  });
});
