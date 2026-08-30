import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

function read(relative: string): string {
  return readFileSync(fileURLToPath(new URL(relative, import.meta.url)), "utf8");
}

describe("Desktop settings information architecture", () => {
  it("groups user-facing preferences by responsibility instead of rendering an engineering dashboard", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    for (const label of ["通用", "本机智能", "小镜", "团队审阅", "高级诊断"]) {
      expect(settings).toContain(label);
    }
    expect(settings).toContain("<DesktopAppearanceControl />");
    expect(settings).toContain("<LocalRuntimePanel baseUrl={baseUrl} />");
    expect(settings).toContain("<AssistantModelsPanel baseUrl={baseUrl} projectId={projectId} />");
    expect(settings).toContain("<CollaborationPanel baseUrl={baseUrl} />");
    expect(settings).toContain('className="team-web-advanced"');
    expect(settings).toContain("自动刷新频率");
  });

  it("does not leak frozen Timeline or release-gate concepts into normal Settings", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    expect(settings).not.toContain("TimelineClient");
    expect(settings).not.toContain("TimelineRuntimeStatus");
    expect(settings).not.toContain("persistenceStatus");
    expect(settings).not.toContain("时间线恢复");
    expect(settings).not.toContain("剪辑 → 时间线");
    expect(settings).not.toContain("development-baseline.json");
    expect(settings).not.toContain("当前能力基线");
    expect(settings).not.toContain("发布门");
  });

  it("uses a single-column preference stack and keeps diagnostics subordinate", () => {
    const css = read("./settings-preferences.css");
    expect(css).toContain(".settings-preference-stack");
    expect(css).toContain("width: min(900px");
    expect(css).toContain(".settings-team-grid { display: grid; grid-template-columns: minmax(0, 1fr)");
    expect(css).toContain(".settings-advanced-diagnostics");
    expect(css).toContain('html[data-mirrororder-theme="light"]');
    expect(css).toContain('html[data-mirrororder-theme="dark"]');
  });
});
