import type { ProjectTaskRecord } from "./tasks";

function targetString(task: ProjectTaskRecord, key: string): string {
  const value = task.targets?.[key];
  return typeof value === "string" ? value.trim() : "";
}

function targetList(task: ProjectTaskRecord, key: string): string[] {
  const value = task.targets?.[key];
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item).trim()).filter(Boolean))].sort();
}

export function taskAttemptTimestamp(task: ProjectTaskRecord): number {
  for (const value of [task.created_at, task.started_at, task.completed_at]) {
    if (!value) continue;
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return 0;
}

export function isTaskActive(task: Pick<ProjectTaskRecord, "status">): boolean {
  return task.status === "queued" || task.status === "running";
}

export function taskFamilyKey(task: ProjectTaskRecord): string {
  const kind = targetString(task, "kind");
  const clipId = targetString(task, "clip_id");
  const mediaId = targetString(task, "media_id");
  const groupIds = targetList(task, "group_ids");
  const clipIds = targetList(task, "clip_ids");

  switch (task.type) {
    case "local_vision_prepare":
      return "local_vision_prepare";
    case "identity_runtime_prepare":
      return `identity_runtime_prepare:${kind || "all"}`;
    case "identity_index":
      // A project exposes one user-facing identity workflow per requested kind.
      // Group-level retries are implementation detail and must not accumulate as
      // separate unresolved issues in Status Center.
      return `identity_index:${kind || "both"}`;
    case "prepare_project":
    case "media_inventory_scan":
    case "multicam_sync":
    case "auto_resolve":
    case "semantic_index":
    case "audit":
    case "perception":
      return task.type;
    case "waveform_build":
      return `waveform_build:${clipId || mediaId || "project"}`;
    case "transcribe":
      return `transcribe:${clipIds.join(",") || "project"}`;
    case "incremental_analyze":
    case "evidence_extract":
      return `${task.type}:${groupIds.join(",") || clipIds.join(",") || "project"}`;
    default:
      return `${task.type}:${kind || "project"}`;
  }
}

export function latestTaskAttempts(tasks: ProjectTaskRecord[]): ProjectTaskRecord[] {
  const ordered = tasks
    .map((task, index) => ({ task, index, timestamp: taskAttemptTimestamp(task) }))
    .sort((left, right) => right.timestamp - left.timestamp || left.index - right.index)
    .map(({ task }) => task);
  const seen = new Set<string>();
  const latest: ProjectTaskRecord[] = [];
  for (const task of ordered) {
    const key = task.idempotency_key?.trim() || task.task_id;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(task);
  }
  return latest;
}

export function latestTaskFamilies(tasks: ProjectTaskRecord[]): ProjectTaskRecord[] {
  const seen = new Set<string>();
  const latest: ProjectTaskRecord[] = [];
  for (const task of latestTaskAttempts(tasks)) {
    const key = taskFamilyKey(task);
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(task);
  }
  return latest;
}

export function currentTaskStates(tasks: ProjectTaskRecord[]): ProjectTaskRecord[] {
  const attempts = latestTaskAttempts(tasks);
  const active = attempts.filter(isTaskActive);
  const activeFamilies = new Set(active.map(taskFamilyKey));
  const settled = latestTaskFamilies(attempts).filter((task) => !activeFamilies.has(taskFamilyKey(task)));
  return [...active, ...settled].sort((left, right) => taskAttemptTimestamp(right) - taskAttemptTimestamp(left));
}
