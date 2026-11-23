// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantModelsPayload } from "../../api/models";
import { syncRecordingStatusLabel } from "../../api/syncTimeline";
import { AssistantModelsPanel } from "./AssistantModelsPanel";

const BASE_URL = "http://host.test";

function json(data: unknown): Response {
  return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
}

function payload(): AssistantModelsPayload {
  return {
    contract: "device_models.v1",
    models: {} as AssistantModelsPayload["models"],
    routing: {
      contract: "model_routing.v1",
      mode: "fallback",
      privacy: "local-only",
      text: { enabled: false, provider: "none", model: "", local: false },
      vision: { enabled: false, provider: "none", model: "", local: false },
      embedding: { enabled: false, provider: "none", model: "", local: true, fallback: "keyword" },
    },
    connections: {
      version: 3,
      text: { enabled: false, provider: "openai-compatible", base_url: "", model: "", has_api_key: false },
      vision: { enabled: false, provider: "openai-compatible", base_url: "", model: "", has_api_key: false },
      embedding: { enabled: true, provider: "local", base_url: "http://127.0.0.1:11434/v1", model: "bge-m3", has_api_key: false },
    },
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
  setter?.call(input, value);
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("AssistantModelsPanel unified multimodal setup", () => {
  let root: Root;
  let container: HTMLDivElement;
  let saved: AssistantModelsPayload;
  let requests: Array<{ method: string; body?: unknown }>;

  beforeEach(() => {
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    saved = payload();
    requests = [];
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname !== "/api/v1/assistant/models") throw new Error(`Unexpected request ${url.pathname}`);
      requests.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
      if (init?.method === "POST") {
        saved = { ...saved, connections: { ...saved.connections, ...(requests.at(-1)?.body as AssistantModelsPayload["connections"]) } };
      }
      return json(saved);
    }));
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
  });

  it("applies DeepSeek to text and vision while retaining embedding and exposes MCP config", async () => {
    await act(async () => root.render(<AssistantModelsPanel baseUrl={BASE_URL} />));
    const preset = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "DeepSeek v4.1 (推荐)");
    expect(preset).toBeDefined();
    await act(async () => preset?.click());

    const key = container.querySelector<HTMLInputElement>('.assistant-quick-connect input[type="password"]');
    expect(key).toBeDefined();
    setInputValue(key!, "deepseek-test-key");
    const apply = [...container.querySelectorAll("button")].find((button) => button.textContent?.trim() === "应用到对话与识图");
    expect(apply).toBeDefined();
    await act(async () => apply?.click());

    const request = requests.find((entry) => entry.method === "POST");
    expect(request?.body).toMatchObject({
      text: { enabled: true, provider: "openai-compatible", base_url: "https://api.deepseek.com/v1", model: "deepseek-v4.1-flash", api_key: "deepseek-test-key" },
      vision: { enabled: true, provider: "openai-compatible", base_url: "https://api.deepseek.com/v1", model: "deepseek-v4.1-flash", api_key: "deepseek-test-key" },
      embedding: { enabled: true, provider: "local", base_url: "http://127.0.0.1:11434/v1", model: "bge-m3" },
    });
    expect(container.textContent).toContain("外部 Agent 接入（MCP）");
    expect(container.textContent).toContain('"script_organizer.mcp_server"');
    expect(container.textContent).toContain("复制 MCP 配置");
  });

  it("labels unconfirmed recordings as alignment work", () => {
    expect(syncRecordingStatusLabel({ recordings: undefined, recording_summary: { status: "unconfirmed", candidate_count: 3, placed_count: 0, unplaced_count: 3, invalid_count: 0 } })).toEqual({ label: "3 条录音待对齐", state: "unconfirmed" });
  });
});
