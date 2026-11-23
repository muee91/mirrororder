const PENDING_SLATE_FILE_PREFIX = "mirrororder.slate.pendingFile:";

function storageKey(projectId: string): string {
  return `${PENDING_SLATE_FILE_PREFIX}${projectId}`;
}

export function rememberPendingSlateFile(projectId: string, path: string): void {
  try {
    globalThis.localStorage?.setItem(storageKey(projectId), path);
  } catch {
    // Device-local convenience storage is best effort.
  }
}

export function readPendingSlateFile(projectId: string): string {
  try {
    return globalThis.localStorage?.getItem(storageKey(projectId)) ?? "";
  } catch {
    return "";
  }
}

export function clearPendingSlateFile(projectId: string): void {
  try {
    globalThis.localStorage?.removeItem(storageKey(projectId));
  } catch {
    // Device-local convenience storage is best effort.
  }
}

export function basenameLabel(path: string): string {
  const value = path.trim().replace(/[\\/]+$/, "");
  if (!value) return "场记文件";
  const basename = value.split(/[\\/]/).pop()?.trim();
  return basename || "场记文件";
}
