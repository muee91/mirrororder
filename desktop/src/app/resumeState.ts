export const PRODUCTION_PAGES = [
  "sync-task",
  "sync-inspect",
  "sync-delivery",
  "media-library",
  "media-binding",
  "takes",
  "identity",
  "slate",
  "script",
  "coverage",
  "rough-cut",
  "assembly",
  "timeline",
  "delivery",
  "watch",
  "attention",
  "overview",
] as const;

export type ProductionPage = (typeof PRODUCTION_PAGES)[number];

export interface AppResumeState {
  workspacePath: string;
  projectId: string;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

const APP_RESUME_KEY = "mirrororder.desktop.resume";
const RECENT_WORKSPACES_KEY = "mirrororder.desktop.recent-workspaces";
const PROJECT_PAGE_PREFIX = "mirrororder.desktop.project-page.";
const DEFAULT_PROJECT_PAGE: ProductionPage = "slate";
const VALID_PROJECT_PAGES = new Set<string>(PRODUCTION_PAGES);

function browserStorage(): StorageLike | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function normalized(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function canonicalProductionPage(page: ProductionPage): ProductionPage {
  if (page === "coverage") return "script";
  if (page === "rough-cut" || page === "assembly" || page === "delivery") return "timeline";
  if (page === "attention" || page === "overview") return "watch";
  return page;
}

export function loadAppResume(storage: StorageLike | null = browserStorage()): AppResumeState {
  if (!storage) return { workspacePath: "", projectId: "" };
  try {
    const raw = storage.getItem(APP_RESUME_KEY);
    if (!raw) return { workspacePath: "", projectId: "" };
    const parsed = JSON.parse(raw) as Partial<AppResumeState> | null;
    if (!parsed || typeof parsed !== "object") return { workspacePath: "", projectId: "" };
    return {
      workspacePath: normalized(parsed.workspacePath),
      projectId: normalized(parsed.projectId),
    };
  } catch {
    return { workspacePath: "", projectId: "" };
  }
}

function distinctRecentWorkspaces(values: readonly unknown[]): string[] {
  const seen = new Set<string>();
  return values.map(normalized).filter(path => {
    if (!path) return false;
    const key = path.replace(/[\\/]+$/, "").replace(/[\\/]workspace\.toml$/i, "").normalize("NFC");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 6);
}

export function loadRecentWorkspaces(storage: StorageLike | null = browserStorage()): string[] {
  if (!storage) return [];
  const lastSuccessfulWorkspace = loadAppResume(storage).workspacePath;
  try {
    const raw = storage.getItem(RECENT_WORKSPACES_KEY);
    const parsed = raw ? JSON.parse(raw) as unknown : null;
    return distinctRecentWorkspaces([
      ...(Array.isArray(parsed) ? parsed : []),
      lastSuccessfulWorkspace,
    ]);
  } catch {
    return distinctRecentWorkspaces([lastSuccessfulWorkspace]);
  }
}

export function rememberRecentWorkspace(workspacePath: string, storage: StorageLike | null = browserStorage()): string[] {
  const nextPath = workspacePath.trim();
  const existing = loadRecentWorkspaces(storage);
  if (!nextPath || !storage) return existing;
  const next = distinctRecentWorkspaces([nextPath, ...existing]);
  try {
    storage.setItem(RECENT_WORKSPACES_KEY, JSON.stringify(next));
  } catch {
    // Device-local convenience only.
  }
  return next;
}

export function rememberWorkspace(workspacePath: string, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  const nextPath = workspacePath.trim();
  if (!nextPath) return;
  try {
    const current = loadAppResume(storage);
    rememberRecentWorkspace(nextPath, storage);
    storage.setItem(APP_RESUME_KEY, JSON.stringify({
      workspacePath: nextPath,
      projectId: current.workspacePath === nextPath ? current.projectId : "",
    } satisfies AppResumeState));
  } catch {
    // Device-local convenience only; it must never block production work.
  }
}

export function rememberProject(projectId: string, storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  const nextProjectId = projectId.trim();
  if (!nextProjectId) return;
  try {
    const current = loadAppResume(storage);
    if (!current.workspacePath) return;
    storage.setItem(APP_RESUME_KEY, JSON.stringify({
      workspacePath: current.workspacePath,
      projectId: nextProjectId,
    } satisfies AppResumeState));
  } catch {
    // Device-local convenience only.
  }
}

export function forgetWorkspaceResume(storage: StorageLike | null = browserStorage()): void {
  if (!storage) return;
  try {
    storage.removeItem(APP_RESUME_KEY);
  } catch {
    // Device-local convenience only.
  }
}

function projectPageKey(projectId: string): string {
  return `${PROJECT_PAGE_PREFIX}${encodeURIComponent(projectId.trim())}`;
}


export function hasRememberedProjectPage(projectId: string, storage: StorageLike | null = browserStorage()): boolean {
  const id = projectId.trim();
  if (!id || !storage) return false;
  try {
    return VALID_PROJECT_PAGES.has(storage.getItem(projectPageKey(id)) ?? "");
  } catch {
    return false;
  }
}

export function readProjectPage(projectId: string, storage: StorageLike | null = browserStorage()): ProductionPage {
  const id = projectId.trim();
  if (!id || !storage) return DEFAULT_PROJECT_PAGE;
  try {
    const value = storage.getItem(projectPageKey(id));
    if (!value || !VALID_PROJECT_PAGES.has(value)) return DEFAULT_PROJECT_PAGE;
    return canonicalProductionPage(value as ProductionPage);
  } catch {
    return DEFAULT_PROJECT_PAGE;
  }
}

export function rememberProjectPage(projectId: string, page: ProductionPage, storage: StorageLike | null = browserStorage()): void {
  const id = projectId.trim();
  if (!id || !VALID_PROJECT_PAGES.has(page) || !storage) return;
  try {
    storage.setItem(projectPageKey(id), canonicalProductionPage(page));
  } catch {
    // Device-local convenience only.
  }
}

export function readSyncSubmissionIssue(workspaceId: string, projectId: string): string {
  try {
    return browserStorage()?.getItem(`mirrororder.desktop.sync-submission.${JSON.stringify([workspaceId, projectId])}`) ?? "";
  } catch {
    return "";
  }
}

export function rememberSyncSubmissionIssue(workspaceId: string, projectId: string, message: string): void {
  const key = `mirrororder.desktop.sync-submission.${JSON.stringify([workspaceId, projectId])}`;
  try {
    const storage = browserStorage();
    if (message) storage?.setItem(key, message);
    else storage?.removeItem(key);
  } catch {
    // The task store is authoritative. This only records errors before submission is confirmed.
  }
}
