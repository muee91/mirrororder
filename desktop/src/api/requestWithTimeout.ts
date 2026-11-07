import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { HostConnectionError } from "./host";

export const API_REQUEST_TIMEOUT_MS = 20_000;

type TauriRequestInit = RequestInit & { connectTimeout?: number };

/** Keep Host reads and writes bounded in browser preview and Tauri. */
export async function fetchWithTimeout(
  input: RequestInfo | URL,
  init: RequestInit = {},
  timeoutMs = API_REQUEST_TIMEOUT_MS,
): Promise<Response> {
  const tauriRuntime = isTauri();
  const controller = new AbortController();
  const requestInit: TauriRequestInit = { ...init };
  if (tauriRuntime) {
    requestInit.connectTimeout = timeoutMs;
  } else {
    requestInit.signal = controller.signal;
  }

  let timer: ReturnType<typeof globalThis.setTimeout> | undefined;
  try {
    const deadline = new Promise<never>((_, reject) => {
      timer = globalThis.setTimeout(() => {
        if (!tauriRuntime) controller.abort();
        reject(new HostConnectionError(`Host 请求超过 ${timeoutMs / 1000} 秒未响应`));
      }, timeoutMs);
    });
    return await Promise.race([
      tauriRuntime ? tauriFetch(input, requestInit) : globalThis.fetch(input, requestInit),
      deadline,
    ]);
  } catch (error) {
    if (error instanceof HostConnectionError) throw error;
    throw new HostConnectionError(`Host 请求失败：${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
