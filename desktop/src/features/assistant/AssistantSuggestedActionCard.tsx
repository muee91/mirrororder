import { useState } from "react";
import { errorMessage } from "../../api/host";
import type { AssistantSuggestedAction } from "../../api/production";
import { ProjectTaskClient } from "../../api/tasks";

export function AssistantSuggestedActionCard({ item, baseUrl, projectId, onOpenSettings, onOpenStatus, onTaskSubmitted }: {
  item: AssistantSuggestedAction;
  baseUrl: string;
  projectId: string;
  onOpenSettings?: () => void;
  onOpenStatus?: () => void;
  onTaskSubmitted?: () => void;
}) {
  const [state, setState] = useState<"ready" | "pending" | "submitted">("ready");
  const [error, setError] = useState("");
  const taskType = item.task_type;
  const isTask = item.action === "submit_task";
  const open = item.action === "open_settings" ? onOpenSettings : item.action === "open_status" ? onOpenStatus : undefined;

  async function submit() {
    if (!taskType || state !== "ready") return;
    setState("pending");
    setError("");
    try {
      await new ProjectTaskClient(baseUrl).submit(projectId, { type: taskType, targets: item.targets, actor: "desktop" });
    } catch (reason) {
      setError(errorMessage(reason));
      setState("ready");
      return;
    }
    setState("submitted");
    onTaskSubmitted?.();
  }

  return <article className="assistant-action-card">
    <strong>{item.label}</strong>
    {item.description && <p>{item.description}</p>}
    <div className="assistant-item-actions">
      {isTask && state === "submitted" ? <>
        <span className="assistant-task-confirmation" role="status">已提交后台任务</span>
        {onOpenStatus && <button type="button" className="secondary" onClick={onOpenStatus}>查看状态中心</button>}
      </> : isTask ? (
        <button type="button" className="secondary" disabled={!taskType || state === "pending"} onClick={() => void submit()}>
          {state === "pending" ? "正在提交…" : "提交后台任务"}
        </button>
      ) : open && (
        <button type="button" className="secondary" onClick={open}>{item.action === "open_settings" ? "打开设置" : "查看状态中心"}</button>
      )}
    </div>
    {error && <p role="alert">{error}</p>}
  </article>;
}
