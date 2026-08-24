import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { PlatformClient } from "./platform";

const mockedInvoke = vi.mocked(invoke);
const mockedIsTauri = vi.mocked(isTauri);

describe("PlatformClient", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedIsTauri.mockReturnValue(true);
  });

  it("reads native platform capabilities", async () => {
    const info = {
      os: "macos",
      family: "unix",
      reveal_path: true,
      open_path: true,
      open_url: true,
      native_dialog: true,
      fcp_adapter: true,
      security_scoped_media: false,
      resolve_adapter: false,
      premiere_adapter: false,
    };
    mockedInvoke.mockResolvedValueOnce(info as never);
    await expect(new PlatformClient().info()).resolves.toEqual(info);
    expect(mockedInvoke).toHaveBeenCalledWith("platform_info", undefined);
  });

  it("normalizes path and URL arguments", async () => {
    mockedInvoke.mockResolvedValue(undefined as never);
    const client = new PlatformClient();
    await client.reveal(" /tmp/demo.mov ");
    await client.open(" /tmp/export.fcpxml ");
    await client.openUrl(" https://example.test/review ");
    expect(mockedInvoke).toHaveBeenNthCalledWith(1, "reveal_path", { path: "/tmp/demo.mov" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(2, "open_path", { path: "/tmp/export.fcpxml" });
    expect(mockedInvoke).toHaveBeenNthCalledWith(3, "open_url", { url: "https://example.test/review" });
  });

  it("rejects unsafe URL schemes before native invocation", async () => {
    const client = new PlatformClient();
    expect(() => client.openUrl("file:///tmp/demo")).toThrow("只允许打开 http:// 或 https://");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });

  it("does not expose native platform commands in browser preview", async () => {
    mockedIsTauri.mockReturnValue(false);
    await expect(new PlatformClient().info()).rejects.toThrow("只在 Tauri Desktop 可用");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
