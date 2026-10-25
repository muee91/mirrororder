import { useEffect, useMemo, useRef, useState } from "react";
import {
  DesktopClient,
  type LocalRuntimeAction,
  type LocalRuntimePayload,
} from "../../api/desktop";
import { errorMessage } from "../../api/host";
import { MODEL_ROUTING_CHANGED_EVENT } from "../../api/models";

interface Props { baseUrl: string }
type Capability = "vision" | "face" | "speaker";

function bytesLabel(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return "0 MB";
  return `${(value / (1024 * 1024)).toFixed(value > 1024 * 1024 * 1024 ? 1 : 0)} MB`;
}

function runtimeStatusLabel(value: string): string {
  return {
    disabled: "未启用",
    unavailable: "运行时不可用",
    missing: "未准备",
    missing_runtime: "运行时未准备",
    not_prepared: "未准备",
    cached: "已缓存 · 正在恢复",
    preparing: "准备中",
    downloading: "下载中",
    loading: "加载中",
    ready: "已准备",
    running: "运行中",
    stopped: "已停止",
    error: "需要处理",
    failed: "失败",
  }[value] ?? value;
}

function statusSummary(next: LocalRuntimePayload): string {
  return `本地 AI ${runtimeStatusLabel(next.vision.status)} · 人脸 ${runtimeStatusLabel(next.identity.face.status)} · 声纹 ${runtimeStatusLabel(next.identity.speaker.status)}`;
}

function shouldOfferRecovery(status: string, lastError?: string): boolean {
  return Boolean(lastError) || ["error", "failed", "unavailable", "missing", "missing_runtime", "not_prepared", "stopped"].includes(status);
}

function notifyRoutingChange(): void {
  globalThis.dispatchEvent(new Event(MODEL_ROUTING_CHANGED_EVENT));
}

export function LocalRuntimePanel({ baseUrl }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const serverModelRef = useRef("");
  const [runtime, setRuntime] = useState<LocalRuntimePayload | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [message, setMessage] = useState("正在读取本地 AI 状态…");

  function apply(next: LocalRuntimePayload, submitted = false): void {
    const previousServerModel = serverModelRef.current;
    serverModelRef.current = next.local_vision_model;
    setRuntime(next);
    setModel((current) => !previousServerModel || current === previousServerModel ? next.local_vision_model : current);
    setMessage(submitted || next.device_task?.task_id
      ? `${statusSummary(next)} · 设备准备任务已提交，可在状态中心查看。`
      : statusSummary(next));
  }

  async function reload(interactive = false): Promise<void> {
    if (interactive && (refreshing || busy)) return;
    if (interactive) setRefreshing(true);
    try {
      apply(await client.localRuntime());
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      if (interactive) setRefreshing(false);
    }
  }

  useEffect(() => { void reload(); }, [client]);

  useEffect(() => {
    if (!runtime) return;
    const preparing = runtime.vision.preparing || runtime.identity.face.preparing || runtime.identity.speaker.preparing;
    if (!preparing) return;
    const timer = globalThis.setTimeout(() => { void reload(); }, 1800);
    return () => globalThis.clearTimeout(timer);
  }, [runtime?.vision.preparing, runtime?.identity.face.preparing, runtime?.identity.speaker.preparing]);

  async function action(payload: LocalRuntimeAction, pending: string): Promise<LocalRuntimePayload | null> {
    setBusy(true);
    setMessage(pending);
    try {
      const next = await client.updateLocalRuntime(payload);
      apply(next);
      return next;
    } catch (error) {
      setMessage(errorMessage(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function setCapability(kind: Capability, enabled: boolean): Promise<void> {
    setBusy(true);
    setMessage(enabled ? "正在启用设备智能能力…" : "正在关闭设备智能能力…");
    try {
      let next = await client.updateLocalRuntime(kind === "vision"
        ? { action: "set", local_vision_enabled: enabled }
        : kind === "face"
          ? { action: "set", face_identity_enabled: enabled }
          : { action: "set", speaker_identity_enabled: enabled });
      if (enabled) {
        next = await client.updateLocalRuntime(kind === "vision"
          ? { action: "prepare" }
          : { action: "prepare_identity", kind });
      }
      apply(next, enabled);
      if (kind === "vision") notifyRoutingChange();
    } catch (error) {
      setMessage(errorMessage(error));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  async function saveModel(): Promise<void> {
    if (!runtime || !model.trim()) return;
    setBusy(true);
    setMessage("正在切换本地 AI 模型…");
    try {
      let next = await client.updateLocalRuntime({ action: "set", local_vision_model: model.trim() });
      if (next.local_vision_enabled) {
        next = await client.updateLocalRuntime({ action: "prepare" });
      }
      apply(next, next.local_vision_enabled);
      setModel(next.local_vision_model);
      notifyRoutingChange();
    } catch (error) {
      setMessage(errorMessage(error));
      await reload();
    } finally {
      setBusy(false);
    }
  }

  const locked = busy || refreshing;

  return (
    <div className="production-panel status-card local-runtime-card">
      <div className="parse-heading">
        <div>
          <p className="eyebrow">本机智能</p>
          <h3>本地 AI 与身份识别</h3>
        </div>
        <button
          type="button"
          className={`secondary settings-refresh-button ${refreshing ? "is-refreshing" : ""}`}
          disabled={locked}
          aria-busy={refreshing}
          onClick={() => void reload(true)}
        >
          <span className="settings-refresh-icon" aria-hidden="true">↻</span>
          <span>刷新</span>
        </button>
      </div>
      <p className="production-note">本地多模态模型负责画面理解；当小镜没有更高优先级的语言模型连接时，也会自动沿用它进行本地对话与推理。</p>
      <p className="production-note">启用一次后，镜序会自动准备当前设备的运行时，并在 Host 下次启动时恢复；切换项目不需要重新激活。</p>
      <p className="production-note">{message}</p>
      {runtime ? (
        <>
          <div className="runtime-switch-grid">
            <label className="settings-check">
              <input type="checkbox" checked={runtime.local_vision_enabled} disabled={locked} onChange={(event) => void setCapability("vision", event.target.checked)} />
              <span>本地多模态模型</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={runtime.face_identity_enabled} disabled={locked} onChange={(event) => void setCapability("face", event.target.checked)} />
              <span>人脸身份</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={runtime.speaker_identity_enabled} disabled={locked} onChange={(event) => void setCapability("speaker", event.target.checked)} />
              <span>声纹身份</span>
            </label>
          </div>
          <div className="runtime-model-row">
            <label className="production-field">
              <span>本地模型</span>
              <input value={model} disabled={locked} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
            </label>
            <button type="button" className="secondary" disabled={locked || !model.trim() || model.trim() === runtime.local_vision_model} onClick={() => void saveModel()}>保存模型</button>
          </div>
          <div className="runtime-status-grid">
            <article>
              <strong>本地 AI</strong><span>{runtime.local_vision_enabled ? runtimeStatusLabel(runtime.vision.status) : "未启用"}</span><small>{bytesLabel(runtime.vision.cache_bytes)} · 文本后备 + 视觉 · {runtime.vision.available ? "运行时可用" : "运行时缺失"}</small>
              {runtime.vision.last_error ? <em>{runtime.vision.last_error}</em> : null}
              {runtime.local_vision_enabled && !runtime.vision.preparing && !runtime.vision.running && shouldOfferRecovery(runtime.vision.status, runtime.vision.last_error) ? <button type="button" disabled={locked} onClick={() => void action({ action: "prepare" }, "正在重新提交本地 AI 准备任务…")}>重新准备</button> : null}
            </article>
            <article>
              <strong>人脸</strong><span>{runtime.face_identity_enabled ? runtimeStatusLabel(runtime.identity.face.status) : "未启用"}</span><small>{bytesLabel(runtime.identity.face.cache_bytes)}</small>
              {runtime.identity.face.last_error ? <em>{runtime.identity.face.last_error}</em> : null}
              {runtime.face_identity_enabled && !runtime.identity.face.preparing && shouldOfferRecovery(runtime.identity.face.status, runtime.identity.face.last_error) ? <button type="button" disabled={locked} onClick={() => void action({ action: "prepare_identity", kind: "face" }, "正在重新提交人脸运行时准备任务…")}>重新准备</button> : null}
            </article>
            <article>
              <strong>声纹</strong><span>{runtime.speaker_identity_enabled ? runtimeStatusLabel(runtime.identity.speaker.status) : "未启用"}</span><small>{bytesLabel(runtime.identity.speaker.cache_bytes)}</small>
              {runtime.identity.speaker.last_error ? <em>{runtime.identity.speaker.last_error}</em> : null}
              {runtime.speaker_identity_enabled && !runtime.identity.speaker.preparing && shouldOfferRecovery(runtime.identity.speaker.status, runtime.identity.speaker.last_error) ? <button type="button" disabled={locked} onClick={() => void action({ action: "prepare_identity", kind: "speaker" }, "正在重新提交声纹运行时准备任务…")}>重新准备</button> : null}
            </article>
          </div>
          <p className="production-note">模型和可选运行时只保存在当前设备。下载、安装与模型加载通过可取消的设备任务进入状态中心；关闭开关会停止使用，但保留已下载缓存，方便下次快速恢复。</p>
        </>
      ) : null}
    </div>
  );
}
