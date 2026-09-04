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
    expect(settings).toContain("<AssistantModelsPanel baseUrl={baseUrl} />");
    expect(settings).toContain("<CollaborationPanel baseUrl={baseUrl} />");
    expect(settings).toContain('className="team-web-advanced"');
    expect(settings).toContain("自动刷新频率");
  });

  it("keeps model and runtime activation device scoped instead of project gated", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    const models = read("../../api/models.ts");
    const panel = read("../assistant/AssistantModelsPanel.tsx");
    const runtime = read("./LocalRuntimePanel.tsx");
    expect(settings).not.toContain("projectId");
    expect(settings).not.toContain("先从左侧选择一个项目");
    expect(models).toContain('const DEVICE_MODEL_PATH = "/api/v1/assistant/models"');
    expect(models).not.toContain("模型设置需要 project_id");
    expect(panel).not.toContain("projectId");
    expect(runtime).toContain("切换项目不需要重新激活");
    expect(runtime).toContain("setCapability");
    expect(runtime).toContain("重新准备");
    expect(runtime).toContain("const locked = busy || refreshing");
    expect(runtime).toContain("reload(true)");
    expect(runtime).toContain("settings-refresh-button");
    expect(runtime).not.toContain("准备 / 启动");
    expect(runtime).not.toContain(">停止</button>");
  });

  it("preserves an unsaved local vision model draft while runtime status is polling", () => {
    const runtime = read("./LocalRuntimePanel.tsx");
    expect(runtime).toContain('const serverModelRef = useRef("")');
    expect(runtime).toContain("const previousServerModel = serverModelRef.current");
    expect(runtime).toContain("current === previousServerModel ? next.local_vision_model : current");
  });

  it("uses refresh motion instead of a persistent success banner", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    const css = read("./settings-preferences.css");
    expect(settings).not.toContain("TRANSIENT_SETTINGS_MESSAGES");
    expect(settings).not.toContain("设置已更新。");
    expect(settings).toContain("settings-refresh-button");
    expect(settings).toContain("settings-refresh-icon");
    expect(settings).toContain("aria-busy={refreshing}");
    expect(settings).toContain("刷新状态");
    expect(css).toContain("settings-refresh-spin");
  });

  it("does not overwrite unsaved Team Web preferences when the top refresh button is used", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    expect(settings).toContain("async function refreshStatus()");
    expect(settings).toContain("await readDeviceStatus();");
    expect(settings).toContain("const settingsDirty");
    expect(settings).toContain("disabled={saving || !settings || !settingsDirty}");
  });

  it("uses guided Chinese controls for the default episode instead of raw storage tokens", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    expect(settings).toContain('type EpisodeMode = "first" | "all" | "number"');
    expect(settings).toContain('<option value="first">首集</option>');
    expect(settings).toContain('<option value="all">全部</option>');
    expect(settings).toContain('<option value="number">指定集数</option>');
    expect(settings).toContain('type="number" min={1} max={9999}');
    expect(settings).not.toContain('placeholder="first / all / 1"');
  });

  it("locks Team Web preference controls while a save is in flight", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    expect(settings).toContain("if (saving) return;");
    expect(settings).toContain("if (!settings || saving || sameSettings(settings, savedSettings)) return;");
    expect(settings).toContain("disabled={saving} onChange={(event) => patchSettings");
  });

  it("keeps model saves meaningful and expandable surfaces discoverable", () => {
    const panel = read("../assistant/AssistantModelsPanel.tsx");
    const css = read("./settings-preferences.css");
    expect(panel).toContain("const dirty = Boolean(payload");
    expect(panel).toContain("disabled={busy || !payload || !dirty}");
    expect(panel).toContain("if (busy) return;");
    expect(panel).toContain("disabled={busy} onChange={(event) => patch");
    expect(panel).not.toContain("设备模型连接已保存。密钥只保存在当前设备，不会在界面中回显。");
    expect(css).toContain(".assistant-models > summary::after");
    expect(css).toContain(".settings-advanced-diagnostics > summary::after");
  });

  it("shows authoritative Xiaojing routing before advanced model overrides", () => {
    const settings = read("./SettingsStatusWorkbench.tsx");
    const models = read("../../api/models.ts");
    const panel = read("../assistant/AssistantModelsPanel.tsx");
    const runtime = read("./LocalRuntimePanel.tsx");

    expect(settings).toContain("AI 能力");
    expect(settings).toContain("显示实际路由 · 高级设置可覆盖");
    expect(models).toContain("EffectiveModelRouting");
    expect(panel).toContain("小镜当前运行方式");
    expect(panel).toContain("payload.routing");
    expect(panel).toContain("关键词检索");
    expect(panel).toContain("高级模型设置");
    expect(panel).toContain("自动沿用已启用的本地多模态模型");
    expect(panel).toContain("外部画面理解只发送抽样帧到所选服务，不上传原始视频文件。");
    expect(runtime).toContain("当小镜没有更高优先级的语言模型连接时");
  });

  it("lets users explicitly clear a saved model API key", () => {
    const panel = read("../assistant/AssistantModelsPanel.tsx");
    expect(panel).toContain("clear_api_key: boolean");
    expect(panel).toContain('else if (row.clear_api_key) value.api_key = ""');
    expect(panel).toContain("清除已保存 Key");
    expect(panel).toContain("保留已保存 Key");
  });

  it("keeps collaboration refresh and permission updates serialized", () => {
    const collaboration = read("./CollaborationPanel.tsx");
    expect(collaboration).toContain("teamSummary");
    expect(collaboration).toContain("const locked = refreshing || Boolean(busyUserId)");
    expect(collaboration).toContain("if (interactive && locked) return;");
    expect(collaboration).toContain("if (locked) return;");
    expect(collaboration).toContain("disabled={locked}");
    expect(collaboration).toContain("reload(true)");
    expect(collaboration).toContain("settings-refresh-button");
    expect(collaboration).not.toContain("团队权限已更新。");
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
