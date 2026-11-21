// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { WorkspaceLauncher } from "./WorkspaceLauncher";

it("uses one primary workspace picker, keeps manifest control under a closed disclosure, and invokes history explicitly", async () => {
  const shell = document.createElement("div");
  const root = createRoot(shell);
  const choose = vi.fn();
  const openRecent = vi.fn();
  const first = "/Volumes/制作盘/前集/workspace.toml";
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  try {
    await act(async () => root.render(<WorkspaceLauncher state="error" recovering={false}
      recoveryFailed native workspacePath={first} serviceAddress="http://localhost:8765"
      message="工作区不可用" recentWorkspaces={[first, "/mnt/后集", "/mnt/第三", "/mnt/第四", "/mnt/第五"]}
      onOpenRecent={openRecent} onChooseWorkspace={choose} onWorkspacePathChange={() => {}}
      onServiceAddressChange={() => {}} onOpenPath={() => {}} onConnect={() => {}} onClearRecovery={() => {}} />));
    const primary = shell.querySelector<HTMLButtonElement>(".startup-primary button");
    const advanced = shell.querySelector<HTMLDetailsElement>("details");
    expect(shell.querySelectorAll(".startup-primary button")).toHaveLength(1);
    expect(advanced?.open).toBe(false);
    expect(advanced?.textContent).toContain("选择 workspace.toml");
    expect(shell.querySelectorAll(".startup-recent button")).toHaveLength(4);
    expect(shell.querySelector(".startup-recent button")?.textContent).toBe("前集（暂不可用）");
    expect(openRecent).not.toHaveBeenCalled();
    await act(async () => primary?.click());
    expect(choose).toHaveBeenCalledWith(true);
    await act(async () => shell.querySelector<HTMLButtonElement>(".startup-recent button")?.click());
    expect(openRecent).toHaveBeenCalledWith(first);
    expect(choose).toHaveBeenCalledTimes(1);
  } finally {
    await act(async () => root.unmount());
    vi.unstubAllGlobals();
  }
});
