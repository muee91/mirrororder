import { invoke, isTauri } from "@tauri-apps/api/core";

export interface PlatformInfo {
  os: string;
  family: string;
  reveal_path: boolean;
  open_path: boolean;
  native_dialog: boolean;
  fcp_adapter: boolean;
  security_scoped_media: boolean;
  resolve_adapter: boolean;
  premiere_adapter: boolean;
}

export class PlatformBridgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PlatformBridgeError";
  }
}

function requireDesktop(): void {
  if (!isTauri()) throw new PlatformBridgeError("平台原生能力只在 Tauri Desktop 可用。");
}

async function callPlatform<T>(command: string, args?: Record<string, unknown>): Promise<T> {
  requireDesktop();
  try {
    return await invoke<T>(command, args);
  } catch (error) {
    throw new PlatformBridgeError(error instanceof Error ? error.message : String(error));
  }
}

export class PlatformClient {
  info(): Promise<PlatformInfo> {
    return callPlatform<PlatformInfo>("platform_info");
  }

  reveal(path: string): Promise<void> {
    const value = path.trim();
    if (!value) throw new PlatformBridgeError("显示路径需要非空 path。");
    return callPlatform<void>("reveal_path", { path: value });
  }

  open(path: string): Promise<void> {
    const value = path.trim();
    if (!value) throw new PlatformBridgeError("打开路径需要非空 path。");
    return callPlatform<void>("open_path", { path: value });
  }
}
