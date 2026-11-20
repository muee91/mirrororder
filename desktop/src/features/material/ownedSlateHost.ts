import type { HostProcessStatus } from "../../api/host";

export function isOwnedSlateHost(baseUrl: string, status: HostProcessStatus) {
  return status.running === true && status.healthy === true &&
    Number.isSafeInteger(status.pid) && (status.pid ?? 0) > 0 &&
    typeof status.workspace_path === "string" && status.workspace_path.length > 0 &&
    /^http:\/\/127\.0\.0\.1:\d+$/.test(baseUrl) && status.base_url === baseUrl;
}
