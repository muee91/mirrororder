import { invoke, isTauri } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AssistantSelection } from "./production";

export interface XiaoJingProjectItem {
  project_id: string;
  name: string;
  input_kind: string;
}

export interface XiaoJingContextSnapshot {
  base_url: string;
  workspace_id: string;
  workspace_name: string;
  projects: XiaoJingProjectItem[];
  project_id: string;
  project_name: string;
  current_page: string;
  selection: AssistantSelection;
  selection_summary: string;
  appearance: string;
}

export interface XiaoJingWindowState {
  visible: boolean;
  always_on_top: boolean;
  global_shortcut: string;
  global_shortcut_registered: boolean;
}

export interface XiaoJingMainAction {
  kind: string;
  project_id?: string | null;
  group_id?: string | null;
  clip_id?: string | null;
  destination?: string | null;
  page?: string | null;
}

export const DEFAULT_XIAOJING_WINDOW_STATE: XiaoJingWindowState = {
  visible: false,
  always_on_top: true,
  global_shortcut: "CommandOrControl+Alt+J",
  global_shortcut_registered: false,
};

function windowCommand(command: string, args?: Record<string, unknown>): Promise<XiaoJingWindowState> {
  return isTauri() ? invoke<XiaoJingWindowState>(command, args) : Promise.resolve(DEFAULT_XIAOJING_WINDOW_STATE);
}

export function toggleXiaoJingWindow() {
  return windowCommand("xiaojing_toggle");
}

export function showXiaoJingWindow() {
  return windowCommand("xiaojing_show");
}

export function hideXiaoJingWindow() {
  return windowCommand("xiaojing_hide");
}

export function setXiaoJingAlwaysOnTop(pinned: boolean) {
  return windowCommand("xiaojing_set_always_on_top", { pinned });
}

export function readXiaoJingWindowState() {
  return windowCommand("xiaojing_window_state");
}

// Both main-window publishers use this queue so an earlier page or selection
// cannot arrive after the main window switches surfaces or workspaces.
let contextWrite = Promise.resolve();
export function syncXiaoJingContext(snapshot: XiaoJingContextSnapshot): Promise<void> {
  if (!isTauri()) return Promise.resolve();
  const next = contextWrite.then(() => invoke<void>("xiaojing_sync_context", { snapshot }));
  contextWrite = next.catch(() => undefined);
  return next;
}

export function readXiaoJingContext(): Promise<XiaoJingContextSnapshot | null> {
  return isTauri() ? invoke<XiaoJingContextSnapshot | null>("xiaojing_get_context") : Promise.resolve(null);
}

export function dispatchXiaoJingAction(action: XiaoJingMainAction): Promise<void> {
  return isTauri() ? invoke<void>("xiaojing_dispatch_action", { action }) : Promise.resolve();
}

function listenPayload<T>(event: string, callback: (payload: T) => void): Promise<() => void> {
  return isTauri() ? listen<T>(event, ({ payload }) => callback(payload)) : Promise.resolve(() => undefined);
}

export function listenXiaoJingContextUpdated(callback: (snapshot: XiaoJingContextSnapshot) => void) {
  return listenPayload("xiaojing:context-updated", callback);
}

export function listenXiaoJingVisibilityChanged(callback: (visible: boolean) => void) {
  return listenPayload("xiaojing:visibility-changed", callback);
}

export function listenXiaoJingMainAction(callback: (action: XiaoJingMainAction) => void) {
  return listenPayload("xiaojing:main-action", callback);
}
