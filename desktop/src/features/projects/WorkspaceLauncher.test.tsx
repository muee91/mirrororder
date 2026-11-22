// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkspaceLauncher } from "./WorkspaceLauncher";

it("uses the DaVinci-style recovery actions without exposing manifest terminology", async () => {
  const shell = document.createElement("div");
  const root = createRoot(shell);
  const choose = vi.fn();
  const openDefault = vi.fn();
  const openRecent = vi.fn();
  const first = "/Volumes/制作盘/前集/workspace.toml";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(<WorkspaceLauncher state="error" recovering={false}
      recoveryFailed native workspacePath={first} serviceAddress="http://localhost:8765"
      message="项目库不可用" recentWorkspaces={[first, "/mnt/后集", "/mnt/第三", "/mnt/第四", "/mnt/第五"]}
      onOpenRecent={openRecent} onOpenDefaultLibrary={openDefault} onChooseWorkspace={choose} onWorkspacePathChange={() => {}}
      onServiceAddressChange={() => {}} onOpenPath={() => {}} onConnect={() => {}} onClearRecovery={() => {}} />));
    const primaryButtons = shell.querySelectorAll<HTMLButtonElement>(".startup-primary-actions button");
    const advanced = shell.querySelector<HTMLDetailsElement>("details");
    expect(primaryButtons).toHaveLength(2);
    expect(primaryButtons[0].textContent).toBe("重新定位项目库…");
    expect(primaryButtons[1].textContent).toBe("进入本机项目库");
    expect(advanced?.open).toBe(false);
    expect(shell.textContent).not.toContain("workspace.toml");
    expect(advanced?.textContent).toContain("选择项目库配置文件…");
    await act(async () => advanced?.querySelector<HTMLButtonElement>(".startup-file button")?.click());
    expect(choose).toHaveBeenCalledWith(false);
    expect(shell.querySelectorAll(".startup-recent button")).toHaveLength(4);
    expect(shell.querySelector(".startup-recent button")?.textContent).toBe("前集（暂不可用）");
    expect(openRecent).not.toHaveBeenCalled();
    await act(async () => primaryButtons[0].click());
    expect(choose).toHaveBeenCalledWith(true);
    await act(async () => primaryButtons[1].click());
    expect(openDefault).toHaveBeenCalledOnce();
    await act(async () => shell.querySelector<HTMLButtonElement>(".startup-recent button")?.click());
    expect(openRecent).toHaveBeenCalledWith(first);
    expect(choose).toHaveBeenCalledTimes(2);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});

it("enters the local project library first and keeps the folder picker secondary", async () => {
  const shell = document.createElement("div");
  const root = createRoot(shell);
  const choose = vi.fn();
  const openDefault = vi.fn();
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(<WorkspaceLauncher state="idle" recovering={false}
      recoveryFailed={false} native workspacePath="" serviceAddress="http://localhost:8765"
      message="" onOpenDefaultLibrary={openDefault} onChooseWorkspace={choose} onWorkspacePathChange={() => {}}
      onServiceAddressChange={() => {}} onOpenPath={() => {}} onConnect={() => {}} onClearRecovery={() => {}} />));
    const buttons = shell.querySelectorAll<HTMLButtonElement>(".startup-primary-actions button");
    expect(buttons[0].textContent).toBe("进入本机项目库");
    expect(buttons[1].textContent).toBe("打开其他项目库…");
    await act(async () => buttons[0].click());
    await act(async () => buttons[1].click());
    expect(openDefault).toHaveBeenCalledOnce();
    expect(choose).toHaveBeenCalledWith(true);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
