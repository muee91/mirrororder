import { invoke, isTauri } from "@tauri-apps/api/core";
import { HostConnectionError } from "./host";

export type TeamGatewayAccess = "lan" | "local";
export type TeamGatewaySecurity = "pairing" | "trusted";

export interface TeamGatewayStartOptions {
  workspacePaths: string[];
  port?: number;
  access?: TeamGatewayAccess;
  security?: TeamGatewaySecurity;
  pairingCode?: string;
}

export interface TeamGatewayStatus {
  running: boolean;
  pid: number | null;
  base_url: string | null;
  lan_url: string | null;
  workspace_paths: string[];
  port: number | null;
  local_only: boolean | null;
  trusted_lan: boolean | null;
  pairing_code: string | null;
}

export interface TeamGatewayLaunchResult {
  pid: number;
  base_url: string;
  lan_url: string | null;
  already_running: boolean;
  workspace_paths: string[];
  port: number;
  local_only: boolean;
  trusted_lan: boolean;
  pairing_code: string;
}

function requireTauri(action: string): void {
  if (!isTauri()) {
    throw new HostConnectionError(`浏览器预览无法${action} Team Web Gateway，请在 Tauri App 中运行`);
  }
}

function normalizeWorkspacePaths(values: string[]): string[] {
  const paths = [...new Set(values.map((value) => value.trim()).filter(Boolean))];
  if (!paths.length) throw new HostConnectionError("Team Web Gateway 至少需要一个 Workspace");
  return paths;
}

function normalizePort(port: number | undefined): number {
  const value = port ?? 8766;
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new HostConnectionError("Gateway 端口必须是 1–65535 的整数");
  }
  return value;
}

export function generatePairingCode(length = 8): string {
  if (!globalThis.crypto?.getRandomValues) {
    throw new HostConnectionError("当前运行时缺少安全随机数，无法生成 pairing code");
  }
  const size = Math.max(6, Math.min(20, Math.floor(length)));
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const values = new Uint32Array(size);
  globalThis.crypto.getRandomValues(values);
  return Array.from(values, (value) => alphabet[value % alphabet.length]).join("");
}

export function teamWorkbenchUrl(
  status: Pick<TeamGatewayStatus | TeamGatewayLaunchResult, "base_url" | "lan_url" | "local_only">,
  workspaceId?: string | null,
  projectId?: string | null,
): string | null {
  const root = status.local_only ? status.base_url : status.lan_url;
  if (!root) return null;
  const url = new URL(root);
  const workspace = workspaceId?.trim();
  const project = projectId?.trim();
  if (workspace) url.searchParams.set("workspace_id", workspace);
  if (project) url.searchParams.set("project_id", project);
  return url.toString();
}

export class TeamGatewayClient {
  async start(options: TeamGatewayStartOptions): Promise<TeamGatewayLaunchResult> {
    requireTauri("启动");
    const workspacePaths = normalizeWorkspacePaths(options.workspacePaths);
    const port = normalizePort(options.port);
    const access = options.access ?? "lan";
    const security = options.security ?? "pairing";
    const pairingCode = security === "pairing"
      ? options.pairingCode?.trim() || generatePairingCode()
      : "";
    try {
      return await invoke<TeamGatewayLaunchResult>("start_team_gateway", {
        workspacePaths,
        port,
        localOnly: access === "local",
        trustedLan: security === "trusted",
        pairingCode,
      });
    } catch (error) {
      throw new HostConnectionError(`启动 Team Web Gateway 失败：${String(error)}`, { cause: error });
    }
  }

  async status(): Promise<TeamGatewayStatus> {
    requireTauri("检查");
    try {
      return await invoke<TeamGatewayStatus>("team_gateway_status");
    } catch (error) {
      throw new HostConnectionError(`读取 Team Web Gateway 状态失败：${String(error)}`, { cause: error });
    }
  }

  async stop(): Promise<void> {
    requireTauri("停止");
    try {
      await invoke("stop_team_gateway");
    } catch (error) {
      throw new HostConnectionError(`停止 Team Web Gateway 失败：${String(error)}`, { cause: error });
    }
  }
}
