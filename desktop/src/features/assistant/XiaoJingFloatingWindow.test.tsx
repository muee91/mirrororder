// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { URL as NodeURL } from "node:url";
import { act, StrictMode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invalidateReviewModelCache } from "../../api/host";
import type { AssistantEvidenceItem, AssistantStatus } from "../../api/production";
import { listenXiaoJingContextUpdated, readXiaoJingContext, toggleXiaoJingWindow, type XiaoJingContextSnapshot } from "../../api/xiaojingWindow";
import { App } from "../../app/App";
import { saveDesktopAppearance } from "../../app/desktopAppearance";
import { XiaoJingFloatingWindow } from "./XiaoJingFloatingWindow";

const bridge = vi.hoisted(() => {
  type Callback = (event: { payload: unknown }) => void;
  const listeners = new Map<string, Set<Callback>>();
  const unlisten = vi.fn();
  return {
    desktop: true,
    listeners,
    unlisten,
    invoke: vi.fn<(command: string, args?: Record<string, unknown>) => Promise<unknown>>(),
    listen: vi.fn(async (event: string, callback: Callback) => {
      const callbacks = listeners.get(event) ?? new Set<Callback>();
      callbacks.add(callback);
      listeners.set(event, callbacks);
      return () => { callbacks.delete(callback); unlisten(event); };
    }),
    fetch: vi.fn<(input: string | URL | Request, init?: RequestInit) => Promise<Response>>(),
    refreshActivities: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@tauri-apps/api/core", async (load) => ({
  ...await load<typeof import("@tauri-apps/api/core")>(),
  invoke: bridge.invoke,
  isTauri: () => bridge.desktop,
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: bridge.listen }));
vi.mock("@tauri-apps/plugin-http", () => ({ fetch: bridge.fetch }));
vi.mock("../projects/projectActivity", () => ({
  useProjectActivities: () => ({ activities: {}, refreshActivities: bridge.refreshActivities }),
}));
vi.mock("../settings/SettingsStatusWorkbench", () => ({ SettingsStatusWorkbench: () => <h1>设置</h1> }));
vi.mock("../status/StatusCenterWorkbench", () => ({ StatusCenterWorkbench: () => <h1>状态中心</h1> }));
vi.mock("../slate/GoldenSlateWorkbench", () => ({ GoldenSlateWorkbench: () => null }));
vi.mock("../material/MaterialTakeView", () => ({
  MaterialTakeView: ({ initialGroupId, initialClipId }: { initialGroupId?: string; initialClipId?: string }) =>
    <div data-group={initialGroupId} data-clip={initialClipId} />,
}));

const BASE = "http://127.0.0.1:8765";
const PROJECT = "/api/v1/projects/p1";
const SECOND_PROJECT = "/api/v1/projects/p2";
const MEDIA_ID = "M_0123456789abcdef01234567";
const ORIGINAL = "/synthetic-media/B02.mov";
const PROJECTS = [
  { project_id: "p1", name: "夜班样片", input_kind: "fcpxml" },
  { project_id: "p2", name: "雨天样片", input_kind: "media-directory" },
];
const CONTEXT: XiaoJingContextSnapshot = {
  base_url: BASE, workspace_id: "w1", workspace_name: "样片工作区", projects: PROJECTS,
  project_id: "p1", project_name: PROJECTS[0].name, current_page: "takes",
  selection: { group_id: "g1", clip_id: "c1", media_id: MEDIA_ID },
  selection_summary: "B 机位 · Take 已选", appearance: "dark",
};
const WINDOW_STATE = { visible: true, always_on_top: true, global_shortcut: "CommandOrControl+Alt+J", global_shortcut_registered: true };
const EVIDENCE: AssistantEvidenceItem = {
  document_id: "speech:g1:c1:0", group_id: "g1", clip_id: "c1", media_id: MEDIA_ID,
  source: "speech", start: 12.4, end: 15.8, snippet: "这一次让我说完。",
  metadata: { time_basis: "take_relative", camera: "B", shot_type_label: "特写",
    file_name: "B02.mov", take_label: "场 4 · Take 2", slate_status: "partial" },
};
const EMPTY_STATUS: AssistantStatus = {
  version: 1, contract: "assistant.v1", revision: 1, updated_at: "", summary: "", items: [], messages: [],
};
const REVIEW = {
  contract_version: "review.v1", project: { project_id: "p1" },
  take_groups: [{ group_id: "g1", angles: [
    { clip_id: "a1", camera: "A", playback: { source_start: 8, source_end: 28 } },
    { clip_id: "c1", media_id: MEDIA_ID, name: "B02.mov", camera: "B", playback: { source_start: 2, source_end: 18 } },
  ] }],
};
const HISTORY: AssistantStatus["messages"] = [
  { role: "user", text: "以前的问题" },
  { role: "assistant", text: "**找到了一条对白**", evidence: [EVIDENCE] },
];
const CONTEXT_EVENT = "xiaojing:context-updated";
const ACTION_EVENT = "xiaojing:main-action";
const VISIBILITY_EVENT = "xiaojing:visibility-changed";

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("XiaoJing floating window", () => {
  let root: Root;
  let container: HTMLDivElement;
  let status: AssistantStatus;
  let routes: Record<string, () => Response | Promise<Response>>;
  let invoke: (command: string, args?: Record<string, unknown>) => Promise<unknown>;
  const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };

  beforeEach(() => {
    vi.clearAllMocks();
    bridge.listeners.clear();
    bridge.desktop = true;
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("navigator", Object.create(navigator, {
      platform: { value: "MacIntel" },
      clipboard: { value: clipboard },
    }));
    window.localStorage.clear();
    invalidateReviewModelCache();
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    status = { ...EMPTY_STATUS };
    routes = {
      [`GET ${PROJECT}/assistant`]: () => json(status),
      [`GET ${SECOND_PROJECT}/assistant`]: () => json({ ...EMPTY_STATUS, messages: [{ role: "user", text: "另一个项目的问题" }] }),
      [`POST ${PROJECT}/assistant/message`]: () => json({ answer: "已核对项目证据。" }),
      [`POST ${SECOND_PROJECT}/assistant/message`]: () => json({ answer: "已核对另一个项目。" }),
      [`POST ${PROJECT}/assistant/clear`]: () => json({ ...status, messages: [] }),
      [`GET ${PROJECT}/review-model`]: () => json(REVIEW),
      "GET /api/v1/assistant/models": () => json({ routing: { text: { enabled: true, local: false, model: "Text Test" } } }),
      "GET /api/v1/ping": () => json({ status: "ok", service: "mirrororder-host" }),
      "GET /api/v1/workspace": () => json({ workspace_id: "w1", workspace: "样片工作区", api_version: "1", projects: PROJECTS }),
    };
    bridge.fetch.mockImplementation(async (input, options) => {
      const route = `${options?.method ?? "GET"} ${new URL(String(input)).pathname}`;
      if (routes[route]) return routes[route]();
      throw new Error(`Unexpected Host request ${route}`);
    });
    invoke = async (command, args) => {
      switch (command) {
        case "xiaojing_get_context": return CONTEXT;
        case "xiaojing_window_state":
        case "xiaojing_toggle": return WINDOW_STATE;
        case "xiaojing_hide": return { ...WINDOW_STATE, visible: false };
        case "xiaojing_set_always_on_top": return { ...WINDOW_STATE, always_on_top: args?.pinned };
        case "xiaojing_dispatch_action":
        case "xiaojing_sync_context":
        case "reveal_path": return undefined;
        case "peek_document_open": return null;
        case "platform_info": return { os: "macos" };
        case "start_python_host": return { pid: 1, base_url: BASE, already_running: true };
        default: throw new Error(`Unexpected IPC command ${command}`);
      }
    };
    bridge.invoke.mockImplementation((command, args) => invoke(command, args));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function renderHud() {
    await act(async () => root.render(<StrictMode><XiaoJingFloatingWindow /></StrictMode>));
  }

  async function emit(event: string, payload: unknown) {
    await act(async () => bridge.listeners.get(event)?.forEach((callback) => callback({ payload })));
  }

  function button(label: string, parent: ParentNode = container) {
    const control = [...parent.querySelectorAll("button")].find((item) =>
      item.getAttribute("aria-label") === label || item.textContent?.trim() === label);
    expect(control, label).toBeDefined();
    return control!;
  }

  async function click(label: string, parent?: ParentNode) {
    await act(async () => button(label, parent).click());
  }

  async function key(target: Window | HTMLElement, value: string, options: KeyboardEventInit = {}) {
    const event = new KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  }

  function requests(path: string, method = "POST") {
    return bridge.fetch.mock.calls.filter(([url, options]) => String(url) === BASE + path && (options?.method ?? "GET") === method)
      .map(([, options]) => typeof options?.body === "string" ? JSON.parse(options.body) : null);
  }

  function ipcRequests(command: string) {
    return bridge.invoke.mock.calls.filter(([name]) => name === command).map(([, args]) => args);
  }

  async function typePrompt(text: string) {
    const field = container.querySelector("textarea")!;
    await act(async () => {
      field.focus();
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value")?.set?.call(field, text);
      field.dispatchEvent(new Event("input", { bubbles: true }));
    });
    return field;
  }

  async function openMonitor() {
    const card = container.querySelector<HTMLButtonElement>(".xj-evidence-card button")!;
    await act(async () => card.click());
    return container.querySelector<HTMLElement>(".xj-monitor")!;
  }

  it("hydrates the context and sends whole-project prompts unless the question refers to the selection", async () => {
    await renderHud();
    expect(bridge.invoke).toHaveBeenCalledWith("xiaojing_get_context");
    expect(container.querySelector(".xj-header-mac")).not.toBeNull();
    const projects = container.querySelector<HTMLSelectElement>('select[aria-label="切换项目"]')!;
    expect(projects.value).toBe("p1");
    expect([...projects.options].map((item) => item.text)).toEqual(["夜班样片", "雨天样片"]);
    expect(container.querySelector(".xj-shortcuts")?.textContent).toContain("⌘⌥J");
    expect(container.querySelector(".xj-model")?.textContent).toContain("云端模型 · Text Test");
    await click("帮我找特写片段");
    const field = await typePrompt("查这条素材");
    expect(await key(field, "Enter", { shiftKey: true })).toBe(false);
    expect(await key(field, "Enter", { isComposing: true })).toBe(false);
    expect(requests(`${PROJECT}/assistant/message`)).toHaveLength(1);
    expect(await key(field, "Enter")).toBe(true);

    expect(requests(`${PROJECT}/assistant/message`)).toEqual([
      { message: "帮我找特写片段", context: { project_id: "p1", page: "takes" } },
      { message: "查这条素材", context: { project_id: "p1", page: "takes", ...CONTEXT.selection } },
    ]);
  });

  it("shows the disconnected state and rehydrates later context events", async () => {
    invoke = async (name) => name === "xiaojing_get_context" ? null : { ...WINDOW_STATE, global_shortcut_registered: false };
    await renderHud();
    expect(container.textContent).toContain("打开一个短剧项目");
    expect(container.querySelector("textarea")).toBeNull();
    await emit(CONTEXT_EVENT, { ...CONTEXT, current_page: "", selection: {}, selection_summary: "" });
    expect(container.querySelector(".xj-shortcuts")?.textContent).not.toContain("⌘⌥J");
    await click("帮我找特写片段");
    expect(requests(`${PROJECT}/assistant/message`)).toEqual([
      { message: "帮我找特写片段", context: { project_id: "p1", page: "slate" } },
    ]);
  });

  it("keeps a newer context event when the initial read resolves late and cleans up its listener", async () => {
    let finish!: (context: XiaoJingContextSnapshot) => void;
    const originalInvoke = invoke;
    invoke = (name, args) => name === "xiaojing_get_context"
      ? new Promise((resolve) => { finish = resolve; }) : originalInvoke(name, args);
    await renderHud();
    expect(bridge.listeners.get(CONTEXT_EVENT)?.size).toBe(1);
    await emit(CONTEXT_EVENT, { ...CONTEXT, project_id: "p2", project_name: "雨天样片" });
    await act(async () => finish(CONTEXT));
    expect(container.querySelector("select")?.value).toBe("p2");
    expect(container.textContent).toContain("另一个项目的问题");
    await act(async () => root.render(null));
    expect(bridge.listeners.get(CONTEXT_EVENT)?.size).toBe(0);
    expect(bridge.unlisten).toHaveBeenCalledWith(CONTEXT_EVENT);
  });

  it.each([40, Infinity, NaN])("uses the inline monitor and bounded original playback with duration %s", async (duration) => {
    status.messages = HISTORY;
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("play requires a click", "NotAllowedError"));
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    await renderHud();
    const card = container.querySelector<HTMLElement>(".xj-evidence-card")!;
    expect(card.dataset.cameraTone).toBe("b");
    expect(card.textContent).toContain("B机");
    expect(card.textContent).toContain("特写");
    expect(card.textContent).toContain("部分可用");
    expect(card.querySelector("time")?.textContent).toBe("00:12.4 – 00:15.8");
    expect(container.querySelector(".assistant-markdown strong")?.textContent).toBe("找到了一条对白");

    const monitor = await openMonitor();
    expect(monitor.previousElementSibling?.classList).toContain("xj-header");
    expect(container.querySelector("dialog")).toBeNull();
    const video = monitor.querySelector("video")!;
    expect(video.src).toBe(`${BASE}${PROJECT}/media/c1?expected_media_id=${MEDIA_ID}`);
    vi.spyOn(video, "duration", "get").mockReturnValue(duration);
    vi.spyOn(video, "paused", "get").mockReturnValue(false);
    await act(async () => {
      video.dispatchEvent(new Event("loadedmetadata"));
      video.dispatchEvent(new Event("playing"));
    });
    expect(video.currentTime).toBeCloseTo(14.4);
    expect(play).toHaveBeenCalledOnce();
    expect(card.querySelector('[aria-label="正在播放"]')).not.toBeNull();
    await act(async () => {
      video.currentTime = 17.8;
      video.dispatchEvent(new Event("timeupdate"));
      video.dispatchEvent(new Event("pause"));
    });
    expect(pause).toHaveBeenCalledOnce();
    expect(card.querySelector('[aria-label="正在播放"]')).toBeNull();
    await click("重播", monitor);
    expect(video.currentTime).toBeCloseTo(14.4);
    expect(play).toHaveBeenCalledTimes(2);
    await click("复制时间码", monitor);
    expect(clipboard.writeText).toHaveBeenCalledWith("B02.mov · 00:14.4 – 00:17.8 · 这一次让我说完。");
    expect(button("已复制", monitor)).toBeDefined();
  });

  it("seeks source-based evidence without adding a Take offset, and rejects finite out-of-range positions", async () => {
    status.messages = [{ role: "assistant", text: "场记原片时间", evidence: [
      { ...EVIDENCE, metadata: { ...EVIDENCE.metadata, time_basis: "source" } },
    ] }];
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockResolvedValue(undefined);
    await renderHud();
    const monitor = await openMonitor();
    const video = monitor.querySelector("video")!;
    const duration = vi.spyOn(video, "duration", "get").mockReturnValue(40);
    await act(async () => video.dispatchEvent(new Event("loadedmetadata")));
    expect(video.currentTime).toBeCloseTo(12.4);
    duration.mockReturnValue(12);
    await click("重播", monitor);
    expect(play).toHaveBeenCalledOnce();
    expect(monitor.querySelector('[role="alert"]')?.textContent).toContain("超出了当前原片时长");
  });

  it.each([true, false])("resolves Finder location on this device (exists=%s)", async (exists) => {
    status.messages = HISTORY;
    routes[`POST ${PROJECT}/media-location`] = () => json({
      contract: "project_media_location.v1", project_id: "p1", clip_id: "c1", media_id: MEDIA_ID,
      exists, file_path: exists ? ORIGINAL : "", device_paths_exposed: true, scope: "device_local_response",
    });
    await renderHud();
    const monitor = await openMonitor();
    await click("Finder 显示", monitor);
    expect(requests(`${PROJECT}/media-location`)).toEqual([{ clip_id: "c1", media_id: MEDIA_ID, group_id: "g1" }]);
    expect(ipcRequests("reveal_path")).toEqual(exists ? [{ path: ORIGINAL }] : []);
    expect(monitor.textContent?.includes("本机暂未绑定原片")).toBe(!exists);
  });

  it("dispatches the Take and updates the pin from window state; Escape closes monitor before hiding", async () => {
    status.messages = HISTORY;
    await renderHud();
    const monitor = await openMonitor();
    await click("主窗定位", monitor);
    expect(ipcRequests("xiaojing_dispatch_action")).toEqual([{ action: {
      kind: "focus_take", project_id: "p1", group_id: "g1", clip_id: "c1", destination: "material",
    } }]);
    expect(button("置顶").getAttribute("aria-pressed")).toBe("true");
    await click("置顶");
    expect(ipcRequests("xiaojing_set_always_on_top")).toEqual([{ pinned: false }]);
    expect(button("置顶").getAttribute("aria-pressed")).toBe("false");
    await key(window, "Escape");
    expect(container.querySelector(".xj-monitor")).toBeNull();
    expect(ipcRequests("xiaojing_hide")).toHaveLength(0);
    expect(document.activeElement).toBe(container.querySelector(".xj-evidence-card button"));
    await key(window, "Escape");
    expect(ipcRequests("xiaojing_hide")).toHaveLength(1);
  });

  it("requires task confirmation, only notifies main on submission, and clears the saved conversation", async () => {
    status.messages = [...HISTORY!, { role: "assistant", text: "建议转写。", suggested_actions: [
      { action: "submit_task", task_type: "transcribe", targets: { group_ids: ["g1"] }, label: "启动语音转写" },
    ] }];
    let finish!: (response: Response) => void;
    routes[`POST ${PROJECT}/tasks`] = () => new Promise((resolve) => { finish = resolve; });
    await renderHud();
    expect(requests(`${PROJECT}/tasks`)).toHaveLength(0);
    await click("提交后台任务");
    expect(button("正在提交…").disabled).toBe(true);
    expect(ipcRequests("xiaojing_dispatch_action")).toEqual([]);
    expect(requests(`${PROJECT}/tasks`)).toEqual([{ type: "transcribe", targets: { group_ids: ["g1"] }, actor: "desktop" }]);
    await act(async () => finish(json({ task_id: "task1", type: "transcribe", status: "queued" })));
    expect(container.textContent).toContain("已提交后台任务");
    expect(ipcRequests("xiaojing_dispatch_action")).toEqual([{ action: { kind: "task_submitted", project_id: "p1" } }]);
    expect(ipcRequests("xiaojing_hide")).toHaveLength(0);
    await click("查看状态中心");
    expect(ipcRequests("xiaojing_dispatch_action").at(-1)).toEqual({ action: { kind: "open_status" } });
    await click("清空对话");
    expect(requests(`${PROJECT}/assistant/clear`)).toEqual([null]);
    expect(container.querySelector(".xj-answer")).toBeNull();
    expect(button("清空对话").disabled).toBe(true);
  });

  it("switches projects, clears the old selection and monitor, and ignores a reply from the previous project", async () => {
    status.messages = HISTORY;
    let finish!: (response: Response) => void;
    routes[`POST ${PROJECT}/assistant/message`] = () => new Promise((resolve) => { finish = resolve; });
    await renderHud();
    await openMonitor();
    await click("找特写");
    expect(button("清空对话").disabled).toBe(true);
    await act(async () => {
      const switcher = container.querySelector("select")!;
      switcher.value = "p2";
      switcher.dispatchEvent(new Event("change", { bubbles: true }));
    });
    expect(ipcRequests("xiaojing_dispatch_action")).toEqual([{ action: { kind: "select_project", project_id: "p2" } }]);
    expect(container.querySelector(".xj-monitor")).toBeNull();
    expect(container.textContent).toContain("另一个项目的问题");
    await act(async () => finish(json({ answer: "旧项目的晚到回答" })));
    expect(container.textContent).not.toContain("旧项目的晚到回答");
    const field = await typePrompt("查这条素材");
    await key(field, "Enter");
    expect(requests(`${SECOND_PROJECT}/assistant/message`)).toEqual([
      { message: "查这条素材", context: { project_id: "p2", page: "sync-task" } },
    ]);
  });

  it("renders safe Markdown, re-asks across the project, and links diagnostics and settings", async () => {
    routes[`POST ${PROJECT}/assistant/message`] = () => json({
      answer: "**现场问题**\n\n- A\n* B\n+ C\n\n1. \x60B02.mov\x60\n\n<img src=x onerror=alert(1)>",
      answer_mode: "deterministic", model_info: { fallback_reason: "http_401" }, suggested_scope_switch: true,
      diagnosis: { destination: "media-binding", summary: "核对原片" },
    });
    await renderHud();
    await click("全项目");
    expect(button("仅选区").title).toBe(CONTEXT.selection_summary);
    await click("这条素材的依据和问题是什么？");
    expect(container.querySelectorAll(".assistant-markdown ul li")).toHaveLength(3);
    expect(container.querySelector(".assistant-markdown ol code")?.textContent).toBe("B02.mov");
    expect(container.querySelector(".assistant-markdown img")).toBeNull();
    expect(container.querySelector(".xj-answer-footer")?.textContent).toContain("模型连接认证失败");
    await click("去设置检查");
    await click("检查本机素材");
    await click("改用「整个项目」重问");
    expect(requests(`${PROJECT}/assistant/message`).map((request) => request.context)).toEqual([
      { project_id: "p1", page: "takes", ...CONTEXT.selection },
      { project_id: "p1", page: "takes" },
    ]);
    expect(ipcRequests("xiaojing_dispatch_action")).toEqual([
      { action: { kind: "open_settings" } },
      { action: { kind: "open_diagnostic", project_id: "p1", page: "media-binding" } },
    ]);
  });

  it("sorts project items by priority, offers Take links, and refreshes on request", async () => {
    status.items = [
      { item_id: "a", title: "普通事项", priority: 10 },
      { item_id: "b", title: "先核对 B 机", priority: 80, group_id: "g1", actions: ["focus", "placement"] },
    ];
    routes[`POST ${PROJECT}/assistant/cycle`] = () => json({ ...EMPTY_STATUS, summary: "检查完成" });
    await renderHud();
    expect(container.querySelector(".xj-item-count[data-priority]")?.textContent).toBe("2");
    await act(async () => container.querySelector<HTMLButtonElement>(".xj-tab-toggle")!.click());
    expect(container.querySelector(".xj-item h3")?.textContent).toBe("先核对 B 机");
    await click("定位 Take");
    await click("去剧本归集");
    expect(ipcRequests("xiaojing_dispatch_action")).toEqual(["material", "script"].map((destination) => ({
      action: { kind: "focus_take", project_id: "p1", group_id: "g1", destination },
    })));
    await click("重新检查");
    expect(requests(`${PROJECT}/assistant/cycle`)).toEqual([{ force_plan: true }]);
    expect(container.querySelector(".xj-items-header")?.textContent).toContain("检查完成");
    expect(container.querySelector(".xj-item-count")?.textContent).toBe("0");
  });

  it("keeps the bridge harmless when the standalone route is opened in a browser", async () => {
    bridge.desktop = false;
    await renderHud();
    const unsubscribe = await listenXiaoJingContextUpdated(vi.fn());
    unsubscribe();
    expect(await readXiaoJingContext()).toBeNull();
    expect((await toggleXiaoJingWindow()).visible).toBe(false);
    expect(await key(window, "Escape")).toBe(false);
    expect(bridge.invoke).not.toHaveBeenCalled();
    expect(bridge.listen).not.toHaveBeenCalled();
    expect(container.querySelector(".xj-header-mac")).toBeNull();
  });

  it("publishes app and project context, handles HUD deep links, and toggles exactly once without squeezing main", async () => {
    localStorage.setItem("mirrororder.desktop.resume", JSON.stringify({ workspacePath: "/fixture", projectId: "" }));
    await act(async () => root.render(<App />));
    expect(ipcRequests("xiaojing_sync_context").at(-1)?.snapshot).toMatchObject({
      workspace_id: "w1", projects: PROJECTS, project_id: "", current_page: "", selection: {},
    });
    expect(await key(window, "j", { metaKey: true })).toBe(true);
    expect(ipcRequests("xiaojing_toggle")).toHaveLength(1);
    await emit(ACTION_EVENT, { kind: "select_project", project_id: "p1" });
    expect(container.querySelector(".surface-production")).not.toBeNull();
    expect(await key(window, "j", { ctrlKey: true, altKey: true })).toBe(false);
    expect(await key(window, "j", { ctrlKey: true, repeat: true })).toBe(false);
    expect(await key(window, "j", { metaKey: true })).toBe(true);
    expect(ipcRequests("xiaojing_toggle")).toHaveLength(2);
    await act(async () => container.querySelector<HTMLButtonElement>(".professional-assistant-toggle")!.click());
    expect(ipcRequests("xiaojing_toggle")).toHaveLength(3);
    await emit(VISIBILITY_EVENT, true);
    expect(container.querySelector(".professional-assistant-toggle")?.getAttribute("aria-expanded")).toBe("true");
    expect(container.querySelector(".assistant-context-drawer, .has-assistant-drawer, .has-assistant-wide")).toBeNull();
    expect(requests(`${PROJECT}/assistant`, "GET")).toHaveLength(0);
    await emit(VISIBILITY_EVENT, false);
    expect(container.querySelector(".professional-assistant-toggle")?.getAttribute("aria-expanded")).toBe("false");

    await emit(ACTION_EVENT, { kind: "focus_take", project_id: "p1", group_id: "g1", clip_id: "c1", destination: "material" });
    expect(container.querySelector('[data-group="g1"][data-clip="c1"]')).not.toBeNull();
    expect(ipcRequests("xiaojing_sync_context").at(-1)?.snapshot).toMatchObject({
      project_id: "p1", current_page: "takes", selection: { group_id: "g1", clip_id: "c1" },
    });
    await emit(ACTION_EVENT, { kind: "open_settings" });
    expect(container.querySelector(".surface-settings")).not.toBeNull();
    await act(async () => saveDesktopAppearance("light"));
    expect(ipcRequests("xiaojing_sync_context").at(-1)?.snapshot).toMatchObject({
      project_id: "p1", current_page: "", selection: {}, selection_summary: "", appearance: "light",
    });
    expect(await key(window, "j", { ctrlKey: true })).toBe(true);
    expect(ipcRequests("xiaojing_toggle")).toHaveLength(4);
    await emit(ACTION_EVENT, { kind: "task_submitted", project_id: "p1" });
    expect(bridge.refreshActivities).toHaveBeenCalledOnce();
    expect(container.querySelector(".surface-settings")).not.toBeNull();
    await emit(ACTION_EVENT, { kind: "open_status" });
    expect(container.querySelector(".surface-status")).not.toBeNull();
    await emit(ACTION_EVENT, { kind: "open_diagnostic", project_id: "p1", page: "media-binding" });
    expect(container.querySelector('[data-material-view="repair"]')).not.toBeNull();
  });

  it("preserves the workbench and native route contracts", () => {
    const workbench = readFileSync(new NodeURL("../production/ProjectWorkbench.tsx", import.meta.url), "utf8");
    for (const token of [
      "const assistantVisible = active && assistantOpen;",
      "professional-assistant-toggle",
      "aria-expanded={assistantOpen}",
      'className="assistant-context-drawer"',
      "{!desktopHud && assistantVisible ? (",
    ]) expect(workbench).toContain(token);
    const entry = readFileSync(new NodeURL("../../main.tsx", import.meta.url), "utf8");
    expect(entry).toContain("<XiaoJingFloatingWindow />");
    expect(entry).not.toContain("xiaojing-floating.css");
    const hud = readFileSync(new NodeURL("./XiaoJingFloatingWindow.tsx", import.meta.url), "utf8");
    for (const token of ["AssistantModelsPanel", "Provider", "Base URL", "API Key", "<dialog"]) expect(hud).not.toContain(token);
  });
});
