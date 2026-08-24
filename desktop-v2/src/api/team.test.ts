import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
  isTauri: vi.fn(() => true),
}));

import { invoke, isTauri } from "@tauri-apps/api/core";
import { TeamGatewayClient, teamWorkbenchUrl } from "./team";

const mockedInvoke = vi.mocked(invoke);
const mockedIsTauri = vi.mocked(isTauri);

describe("TeamGatewayClient", () => {
  beforeEach(() => {
    mockedInvoke.mockReset();
    mockedIsTauri.mockReturnValue(true);
  });

  it("starts an isolated LAN gateway with deduplicated workspaces", async () => {
    mockedInvoke.mockResolvedValueOnce({
      pid: 42,
      base_url: "http://127.0.0.1:8766",
      lan_url: "http://192.168.1.20:8766",
      already_running: false,
      workspace_paths: ["/work/A", "/work/B"],
      port: 8766,
      local_only: false,
      trusted_lan: true,
      pairing_code: "",
    } as never);

    const result = await new TeamGatewayClient().start({
      workspacePaths: [" /work/A ", "/work/A", "/work/B"],
      access: "lan",
      security: "trusted",
    });

    expect(result.pid).toBe(42);
    expect(mockedInvoke).toHaveBeenCalledWith("start_team_gateway", {
      workspacePaths: ["/work/A", "/work/B"],
      port: 8766,
      localOnly: false,
      trustedLan: true,
      pairingCode: "",
    });
  });

  it("builds a project-scoped Team Web link without inventing routes", () => {
    expect(teamWorkbenchUrl(
      { base_url: "http://127.0.0.1:8766", lan_url: "http://10.0.0.8:8766" },
      "ws one",
      "p/1",
    )).toBe("http://10.0.0.8:8766/?workspace_id=ws+one&project_id=p%2F1");
  });

  it("keeps Team Web native-only", async () => {
    mockedIsTauri.mockReturnValue(false);
    await expect(new TeamGatewayClient().status()).rejects.toThrow("Tauri App");
    expect(mockedInvoke).not.toHaveBeenCalled();
  });
});
