// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { FinderProjectOpen } from "./FinderProjectOpen";

const bridge = vi.hoisted(() => ({
  next: null as { id: number; path: string } | null,
  updated: null as (() => void) | null,
  invoke: vi.fn(), inspect: vi.fn(), submit: vi.fn(), unlisten: vi.fn(), tasks: vi.fn(),
}));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke: bridge.invoke }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: async (_name: string, callback: () => void) => {
    bridge.updated = callback;
    return bridge.unlisten;
  },
}));
vi.mock("../api/projectActions", () => ({
  ProjectActionClient: class {
    inspectPackage = bridge.inspect;
    importPackage = bridge.submit;
  },
}));
vi.mock("../api/tasks", () => ({ DeviceTaskClient: class { list = bridge.tasks; } }));

const filepath = "/tmp/剪辑 甲/竖屏测试.mirrorproj";
const destination = { id: "ws-甲", name: "剪辑 甲", baseUrl: "http://127.0.0.1:8765", projects: [] };
let root: Root;
let container: HTMLDivElement;
const open = vi.fn(async (_id: string) => {});
const notice = vi.fn();
const signal = new AbortController().signal;
const project = { project_id: "demo", name: "竖屏测试", package_path: filepath };
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  bridge.next = null;
  bridge.updated = null;
  bridge.invoke.mockReset().mockImplementation(async (name, payload) => {
    if (name === "peek_document_open") return bridge.next;
    expect(payload.id).toBe(bridge.next?.id);
    bridge.next = null;
  });
  bridge.inspect.mockReset().mockResolvedValue(project);
  bridge.submit.mockReset().mockResolvedValue({ package: project, task: { task_id: "native-1" } });
  bridge.tasks.mockReset().mockResolvedValue([{ task_id: "native-1", status: "completed" }]);
  open.mockClear();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
async function render(value: { id: string; name: string; baseUrl: string; projects: { project_id: string }[] } | null) {
  await act(async () => root.render(<FinderProjectOpen destination={value} signal={signal} onOpen={open} onNotice={notice} />));
}
function button(title: string) {
  return [...container.querySelectorAll("button")].find(node => node.textContent === title);
}
async function click(title: string) {
  const control = button(title);
  expect(control).toBeDefined();
  await act(async () => control?.click());
}
it("retains the cold-open package until a fresh workspace exists, then opens by validated import", async () => {
  bridge.next = { id: 1, path: filepath };
  await render(null);
  expect(container.textContent).toContain("先打开或恢复一个工作区");
  expect(bridge.inspect).not.toHaveBeenCalled();
  expect(bridge.submit).not.toHaveBeenCalled();
  await render(destination);
  expect(bridge.inspect).toHaveBeenCalledWith(filepath);
  expect(bridge.submit).not.toHaveBeenCalled();
  await click("导入并打开");
  expect(bridge.submit).toHaveBeenCalledWith(filepath, { expectedWorkspaceId: destination.id, expectedProjectId: "demo" });
  expect(open).toHaveBeenCalledWith("demo");
  expect(bridge.invoke).toHaveBeenCalledWith("finish_document_open", { id: 1 });
  expect(container.textContent).toBe("");
});
it("handles a warm-open event and never imports or overwrites a different existing same-ID project", async () => {
  await render({ ...destination, projects: [{ project_id: "demo" }] });
  bridge.next = { id: 8, path: filepath };
  await act(async () => bridge.updated?.());
  expect(container.textContent).toContain("已存在同编号的工程");
  expect(open).not.toHaveBeenCalled();
  expect(bridge.submit).not.toHaveBeenCalled();
  await click("打开已有工程");
  expect(open).toHaveBeenCalledWith("demo");
  expect(bridge.submit).not.toHaveBeenCalled();
});
it("can cancel a pending cold request before selecting a workspace", async () => {
  bridge.next = { id: 10, path: filepath };
  await render(null);
  await click("取消");
  await render(destination);
  expect(bridge.inspect).not.toHaveBeenCalled();
  expect(bridge.submit).not.toHaveBeenCalled();
});
it("does not submit after failed validation and permits explicit validation retry", async () => {
  bridge.next = { id: 11, path: filepath };
  bridge.inspect.mockRejectedValueOnce(new Error("文件无法读取"));
  await render(destination);
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("文件无法读取");
  expect(button("导入并打开")).toBeUndefined();
  await click("重新检查");
  expect(bridge.inspect).toHaveBeenCalledTimes(2);
  expect(button("导入并打开")).toBeDefined();
  expect(bridge.submit).not.toHaveBeenCalled();
});

it("never re-sends an import after an ambiguous submission result", async () => {
  bridge.next = { id: 12, path: filepath };
  bridge.submit.mockRejectedValueOnce(new Error("连接中断"));
  await render(destination);
  await click("导入并打开");
  expect(container.querySelector('[role="alert"]')?.textContent).toContain("本请求不会重发");
  expect(button("导入并打开")).toBeUndefined();
  expect(button("重新检查")).toBeUndefined();
  expect(bridge.submit).toHaveBeenCalledTimes(1);
  expect(bridge.invoke).not.toHaveBeenCalledWith("finish_document_open", { id: 12 });
  await click("关闭");
});
