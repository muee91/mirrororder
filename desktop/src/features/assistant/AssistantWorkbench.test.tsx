// @vitest-environment jsdom
import { act, type ComponentProps } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MODEL_ROUTING_CHANGED_EVENT } from "../../api/models";
import type { AssistantAnswer, AssistantEvidenceItem, AssistantStatus } from "../../api/production";
import { EvidencePreview } from "../production/EvidencePreview";
import { ProjectWorkbench } from "../production/ProjectWorkbench";
import { evidenceLocation } from "../production/evidenceLocation";
import { AssistantWorkbench } from "./AssistantWorkbench";

vi.mock("../slate/GoldenSlateWorkbench", () => ({ GoldenSlateWorkbench: () => null }));

const BASE_URL = "http://host.test";
const PROJECT_PATH = "/api/v1/projects/p1";
const MODEL_PATH = "/api/v1/assistant/models";
const EVIDENCE: AssistantEvidenceItem = {
  document_id: "speech:g1:c1:0",
  group_id: "g1",
  clip_id: "c1",
  source: "speech",
  start: 12.4,
  end: 15.8,
  snippet: "这一次让我说完。",
  metadata: { camera: "B", shot_type_label: "特写", slate_status: "partial", take_label: "场 4 · Take 2", time_basis: "take_relative" },
};

const STATUS: AssistantStatus = {
  version: 1, contract: "assistant.v1", revision: 1, updated_at: "", summary: "", items: [], messages: [],
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

describe("AssistantWorkbench", () => {
  let container: HTMLDivElement;
  let root: Root;
  let status: AssistantStatus;
  let answer: AssistantAnswer;
  let routes: Record<string, () => Response | Promise<Response>>;
  const fetchHost = vi.fn(async (input: RequestInfo | URL, request?: RequestInit): Promise<Response> => {
    const path = new URL(String(input)).pathname;
    const route = routes[`${request?.method ?? "GET"} ${path}`];
    if (route) return route();
    throw new Error(`Unexpected Host request ${path}`);
  });
  const readContext = vi.fn((includeSelection: boolean) => ({
    project_id: "p1", page: "takes", ...(includeSelection ? { clip_id: "c1" } : {}),
  }));
  const onOpenEvidence = vi.fn();
  const onFocusTake = vi.fn();
  const onOpenDiagnostic = vi.fn();
  const onOpenSettings = vi.fn();
  const onOpenStatus = vi.fn();
  const onTaskSubmitted = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("fetch", fetchHost);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    status = { ...STATUS };
    answer = { answer: "回答已生成。" };
    routes = {
      [`GET ${PROJECT_PATH}/assistant`]: () => json(status),
      [`POST ${PROJECT_PATH}/assistant/message`]: () => json(answer),
      [`GET ${MODEL_PATH}`]: () => json({ error: "暂不可读" }, 503),
    };
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  async function render(props: Partial<ComponentProps<typeof AssistantWorkbench>> = {}) {
    await act(async () => root.render(<AssistantWorkbench
      baseUrl={BASE_URL} projectId="p1" currentPage="takes" draft={{ text: "", includeSelection: true }}
      selectionSummary="B 机位 · Take 已选" readContext={readContext}
      onOpenEvidence={onOpenEvidence} onFocusTake={onFocusTake} onOpenDiagnostic={onOpenDiagnostic}
      onOpenSettings={onOpenSettings} onOpenStatus={onOpenStatus} onTaskSubmitted={onTaskSubmitted}
      {...props}
    />));
  }

  function button(label: string, parent: ParentNode = container) {
    const control = [...parent.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
    expect(control, label).toBeDefined();
    return control!;
  }

  async function click(label: string, parent?: ParentNode) {
    await act(async () => button(label, parent).click());
  }

  function requests(path: string, method = "POST") {
    return fetchHost.mock.calls.filter(([url, request]) => String(url) === BASE_URL + path && request?.method === method)
      .map(([, request]) => typeof request?.body === "string" ? JSON.parse(request.body) : undefined);
  }

  it("uses project scope for general prompts, includes deictic selection, and pins selection until toggled back", async () => {
    await render({ draft: { text: "查这条素材", includeSelection: true } });
    expect(button("全项目").getAttribute("aria-pressed")).toBe("false");
    await click("帮我找特写片段");
    await click("发送");
    await click("全项目");
    expect(button("仅当前选区").getAttribute("aria-pressed")).toBe("true");
    await click("帮我找特写片段");
    await click("仅当前选区");
    await click("帮我找特写片段");

    expect(readContext.mock.calls).toEqual([[false], [true], [true], [false]]);
    expect(requests(`${PROJECT_PATH}/assistant/message`)).toEqual([
      { message: "帮我找特写片段", context: { project_id: "p1", page: "takes" } },
      { message: "查这条素材", context: { project_id: "p1", page: "takes", clip_id: "c1" } },
      { message: "帮我找特写片段", context: { project_id: "p1", page: "takes", clip_id: "c1" } },
      { message: "帮我找特写片段", context: { project_id: "p1", page: "takes" } },
    ]);
  });

  it("re-asks the same deictic question across the project when a scope switch is suggested", async () => {
    answer = { answer: "当前选区暂无证据。", suggested_scope_switch: true };
    await render();
    await click("全项目");
    const question = "这条素材的依据和问题是什么？";
    await click(question);
    answer = { answer: "整个项目已检索。", retrieval: { results: [EVIDENCE] } };
    await click("改用「整个项目」重问");

    expect(readContext.mock.calls).toEqual([[true], [false]]);
    expect(requests(`${PROJECT_PATH}/assistant/message`).map((request) => request.message)).toEqual([question, question]);
    expect(button("全项目")).toBeDefined();
    expect(container.querySelector(".assistant-evidence-card")?.textContent).toContain(EVIDENCE.snippet);
  });

  it("hydrates played evidence, take focus, diagnosis, and suggested navigation from persisted messages", async () => {
    status.messages = [
      { role: "user", text: "之前的提问", created_at: "2026-01-01T12:00:00Z" },
      {
        role: "assistant", text: "记录中的回答", evidence: [EVIDENCE], answer_mode: "diagnosis",
        diagnosis: { summary: "检查绑定后继续", destination: "media-binding" },
        suggested_actions: [
          { action: "open_settings", label: "连接文字模型", description: "在设备设置中检查。" },
          { action: "open_status", label: "当前后台工作" },
        ],
      },
    ];
    await render();
    const card = container.querySelector(".assistant-evidence-card")!;
    expect(card.textContent).toContain("B机");
    expect(card.textContent).toContain("特写");
    expect(card.textContent).toContain("部分可用");
    expect(card.textContent).toContain("00:12.4 – 00:15.8");
    expect(card.textContent).toContain(EVIDENCE.snippet);
    expect(container.querySelector(".assistant-mode-badge")?.textContent).toBe("同步诊断");
    await act(async () => card.querySelector("button.assistant-evidence-body")?.dispatchEvent(new MouseEvent("click", { bubbles: true })));
    await click("定位 Take", card);
    await click("检查本机素材");
    await click("打开设置");
    await click("查看状态中心");
    expect(onOpenEvidence).toHaveBeenCalledWith(EVIDENCE);
    expect(onFocusTake).toHaveBeenCalledWith("g1", "material", "c1");
    expect(onOpenDiagnostic).toHaveBeenCalledWith("media-binding");
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(onOpenStatus).toHaveBeenCalledOnce();
  });

  it("submits the sync quick prompt, shows thinking, and renders Markdown as React text and elements", async () => {
    let finish!: (response: Response) => void;
    routes[`POST ${PROJECT_PATH}/assistant/message`] = () => new Promise((resolve) => { finish = resolve; });
    const clipboard = { writeText: vi.fn().mockResolvedValue(undefined) };
    vi.stubGlobal("navigator", Object.create(navigator, { clipboard: { value: clipboard } }));
    await render({ currentPage: "sync-delivery", selectionSummary: "" });

    await click("现在能交付吗？卡在哪？");
    expect(container.querySelector(".assistant-thinking")?.textContent).toContain("正在核对项目证据");
    expect(button("清空对话").disabled).toBe(true);
    const text = "**可以核对**\n\n- 查看 `B02.mov`\n- 听原片\n\n1. 核对同步\n2. 导出工程\n\n<script>window.injected=true</script>";
    await act(async () => finish(json({ answer: text, answer_mode: "llm" })));

    expect(requests(`${PROJECT_PATH}/assistant/message`)[0].message).toBe("现在能交付吗？卡在哪？");
    expect(container.querySelector(".assistant-thinking")).toBeNull();
    expect(container.querySelector(".assistant-markdown p strong")?.textContent).toBe("可以核对");
    expect(container.querySelector(".assistant-markdown ul li code")?.textContent).toBe("B02.mov");
    expect([...container.querySelectorAll(".assistant-markdown ol li")].map((item) => item.textContent)).toEqual(["核对同步", "导出工程"]);
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<script>window.injected=true</script>");
    expect(container.querySelector(".assistant-mode-badge")?.textContent).toBe("AI 管家");
    await click("复制");
    expect(clipboard.writeText).toHaveBeenCalledWith(text);
    expect(button("已复制")).toBeDefined();
  });

  it("requires confirmation before submitting a background task, then links to the status center", async () => {
    answer = { answer: "还没有对白索引。", suggested_actions: [{
      action: "submit_task", task_type: "transcribe", targets: { group_ids: ["g1"] },
      label: "启动语音转写", description: "转写完成后可以检索对白。",
    }] };
    let finish!: (response: Response) => void;
    routes[`POST ${PROJECT_PATH}/tasks`] = () => new Promise((resolve) => { finish = resolve; });
    await render();
    await click("项目现在还有哪些缺口和待处理？");
    expect(requests(`${PROJECT_PATH}/tasks`)).toEqual([]);
    expect(container.querySelector(".assistant-action-card")?.textContent).toContain("转写完成后可以检索对白。");
    await click("提交后台任务");
    expect(button("正在提交…").disabled).toBe(true);
    expect(onTaskSubmitted).not.toHaveBeenCalled();
    expect(requests(`${PROJECT_PATH}/tasks`)).toEqual([{ type: "transcribe", targets: { group_ids: ["g1"] }, actor: "desktop" }]);
    await act(async () => finish(json({ task_id: "t1", type: "transcribe", status: "queued", stage: "queued" })));
    expect(container.querySelector(".assistant-task-confirmation")?.textContent).toBe("已提交后台任务");
    expect(onTaskSubmitted).toHaveBeenCalledOnce();
    await click("查看状态中心");
    expect(onOpenStatus).toHaveBeenCalledOnce();
  });

  it("clears stored turns, prioritizes project items, and refreshes them on request", async () => {
    status = {
      ...STATUS, summary: "有两个事项",
      messages: [{ role: "user", text: "刚才的问题" }, { role: "assistant", text: "刚才的回答" }],
      items: [
        { item_id: "low", title: "普通事项", priority: 10 },
        { item_id: "high", title: "先看这个", priority: 80, group_id: "g1", actions: ["focus", "placement"] },
      ],
    };
    routes[`POST ${PROJECT_PATH}/assistant/clear`] = () => json({ ...status, messages: [] });
    routes[`POST ${PROJECT_PATH}/assistant/cycle`] = () => json({ ...STATUS, summary: "检查完成" });
    await render();

    expect(container.querySelector(".assistant-items-count.has-high")?.textContent).toBe("2");
    await click("清空对话");
    expect(requests(`${PROJECT_PATH}/assistant/clear`)).toEqual([undefined]);
    expect(container.querySelector(".assistant-turn")).toBeNull();
    expect(button("清空对话").disabled).toBe(true);

    await click("项目事项 2");
    expect(button("项目事项 2").getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".assistant-project-items")?.hasAttribute("hidden")).toBe(false);
    expect(container.querySelector(".assistant-item strong")?.textContent).toBe("先看这个");
    await click("定位 Take");
    await click("去剧本归集");
    expect(onFocusTake.mock.calls).toEqual([["g1", "material"], ["g1", "script"]]);
    await click("重新检查");
    expect(requests(`${PROJECT_PATH}/assistant/cycle`)).toEqual([{ force_plan: true }]);
    expect(container.querySelector(".assistant-items-summary")?.textContent).toContain("检查完成");
    expect(container.querySelector(".assistant-items-count")?.textContent).toBe("0");
    expect(container.querySelector(".assistant-items-count.has-high")).toBeNull();
  });

  it("offers configuration when model status is unavailable and refreshes live routing on the change event", async () => {
    await render();
    expect(container.querySelector(".assistant-model-pill")?.textContent).toContain("离线直检模式");
    await click("配置模型");
    expect(onOpenSettings).toHaveBeenCalledOnce();
    routes[`GET ${MODEL_PATH}`] = () => json({ routing: { text: { enabled: true, local: true, model: "Local Test" } } });
    await act(async () => window.dispatchEvent(new Event(MODEL_ROUTING_CHANGED_EVENT)));
    expect(container.querySelector(".assistant-model-pill")?.textContent).toContain("本地模型 · Local Test");
    expect(container.textContent).not.toContain("配置模型");

    answer = { answer: "已用缓存证据回答。", model_info: { fallback_reason: "http_401" }, answer_mode: "deterministic" };
    await click("帮我找特写片段");
    expect(container.querySelector(".assistant-answer-footer")?.textContent).toContain("模型连接认证失败");
    await click("检查设置");
    expect(onOpenSettings).toHaveBeenCalledTimes(2);
  });

  it("seeks, starts, and replays a preview even when autoplay is denied", async () => {
    const play = vi.spyOn(HTMLMediaElement.prototype, "play").mockRejectedValue(new DOMException("Autoplay denied", "NotAllowedError"));
    const pause = vi.spyOn(HTMLMediaElement.prototype, "pause").mockImplementation(() => undefined);
    const selection = evidenceLocation("p1", { source: "slate", clip_id: "c1", start: 12.4, end: 15.8 });
    await act(async () => root.render(<EvidencePreview baseUrl={BASE_URL} selection={selection} onClose={vi.fn()} onRepair={vi.fn()} />));
    const video = container.querySelector("video")!;
    vi.spyOn(video, "duration", "get").mockReturnValue(40);
    vi.spyOn(video, "paused", "get").mockReturnValue(false);
    await act(async () => { video.dispatchEvent(new Event("loadedmetadata")); });
    expect(video.currentTime).toBe(12.4);
    expect(play).toHaveBeenCalledOnce();

    video.currentTime = 15.8;
    await act(async () => { video.dispatchEvent(new Event("timeupdate")); });
    expect(pause).toHaveBeenCalledOnce();
    await click("重播命中片段");
    expect(video.currentTime).toBe(12.4);
    expect(play).toHaveBeenCalledTimes(2);
  });

  it("toggles the real project drawer by keyboard, preserves its width and stops listening when inactive", async () => {
    const project = { project_id: "p1", name: "测试项目", input_kind: "fcpxml", stats: {} };
    const renderShell = (active: boolean) => act(async () => {
      root.render(<ProjectWorkbench baseUrl={BASE_URL} project={project} active={active} onOpenSettings={onOpenSettings} />);
    });
    const shortcut = async (options: KeyboardEventInit) => {
      const event = new KeyboardEvent("keydown", { key: "j", cancelable: true, ...options });
      await act(async () => window.dispatchEvent(event));
      return event.defaultPrevented;
    };
    await renderShell(true);
    expect(await shortcut({ ctrlKey: true, altKey: true })).toBe(false);
    expect(await shortcut({ metaKey: true, isComposing: true })).toBe(false);
    expect(container.querySelector(".assistant-context-drawer")).toBeNull();
    expect(await shortcut({ ctrlKey: true })).toBe(true);
    const drawer = container.querySelector<HTMLElement>(".assistant-context-drawer")!;
    expect(drawer.hidden).toBe(false);
    await click("加宽");
    expect(drawer.classList.contains("is-wide")).toBe(true);
    expect(drawer.closest(".has-assistant-drawer.has-assistant-wide")).not.toBeNull();
    await click("配置模型");
    expect(onOpenSettings).toHaveBeenCalledOnce();
    expect(await shortcut({ metaKey: true })).toBe(true);
    expect(drawer.isConnected).toBe(false);
    expect(container.querySelector(".has-assistant-drawer")).toBeNull();
    await renderShell(false);
    expect(await shortcut({ ctrlKey: true })).toBe(false);
    await renderShell(true);
    expect(container.querySelector(".assistant-context-drawer")).toBeNull();
    expect(await shortcut({ ctrlKey: true })).toBe(true);
    const reopened = container.querySelector<HTMLElement>(".assistant-context-drawer")!;
    expect(reopened.hidden).toBe(false);
    expect(reopened.classList.contains("is-wide")).toBe(true);
    await click("标准");
    expect(reopened.classList.contains("is-wide")).toBe(false);
  });
});
