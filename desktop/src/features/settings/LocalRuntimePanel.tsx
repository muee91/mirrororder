import { useEffect, useMemo, useState } from "react";
import {
  DesktopClient,
  type LocalRuntimeAction,
  type LocalRuntimePayload,
} from "../../api/desktop";
import { HostConnectionError } from "../../api/host";

interface Props { baseUrl: string }

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

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
    cached: "已缓存",
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
  return `视觉 ${runtimeStatusLabel(next.vision.status)} · 人脸 ${runtimeStatusLabel(next.identity.face.status)} · 声纹 ${runtimeStatusLabel(next.identity.speaker.status)}`;
}

export function LocalRuntimePanel({ baseUrl }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [runtime, setRuntime] = useState<LocalRuntimePayload | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取本地模型状态…");

  async function reload(): Promise<void> {
    try {
      const next = await client.localRuntime();
      setRuntime(next);
      setModel(next.local_vision_model);
      setMessage(statusSummary(next));
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => { void reload(); }, [client]);

  async function action(payload: LocalRuntimeAction, pending: string): Promise<void> {
    setBusy(true);
    setMessage(pending);
    try {
      const next = await client.updateLocalRuntime(payload);
      setRuntime(next);
      setModel(next.local_vision_model);
      if (next.device_task?.task_id) {
        setMessage(`${statusSummary(next)} · 准备任务已提交到状态中心，可继续使用其他功能。`);
      } else {
        setMessage(statusSummary(next));
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="production-panel status-card local-runtime-card">
      <div className="parse-heading">
        <div>
          <p className="eyebrow">本机智能</p>
          <h3>本地模型与身份识别</h3>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button>
      </div>
      <p className="production-note">{message}</p>
      {runtime ? (
        <>
          <div className="runtime-switch-grid">
            <label className="settings-check">
              <input type="checkbox" checked={runtime.local_vision_enabled} disabled={busy} onChange={(event) => void action({ action: "set", local_vision_enabled: event.target.checked }, "正在更新本地视觉设置…")} />
              <span>本地视觉</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={runtime.face_identity_enabled} disabled={busy} onChange={(event) => void action({ action: "set", face_identity_enabled: event.target.checked }, "正在更新人脸识别设置…")} />
              <span>人脸身份</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={runtime.speaker_identity_enabled} disabled={busy} onChange={(event) => void action({ action: "set", speaker_identity_enabled: event.target.checked }, "正在更新声纹识别设置…")} />
              <span>声纹身份</span>
            </label>
          </div>
          <div className="runtime-model-row">
            <label className="production-field">
              <span>视觉模型</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
            </label>
            <button type="button" className="secondary" disabled={busy || !model.trim() || model.trim() === runtime.local_vision_model} onClick={() => void action({ action: "set", local_vision_model: model.trim() }, "正在切换本地视觉模型…")}>保存模型</button>
          </div>
          <div className="runtime-status-grid">
            <article>
              <strong>视觉</strong><span>{runtimeStatusLabel(runtime.vision.status)}</span><small>{bytesLabel(runtime.vision.cache_bytes)} · {runtime.vision.available ? "本地运行时可用" : "本地运行时缺失"}</small>
              {runtime.vision.last_error ? <em>{runtime.vision.last_error}</em> : null}
              <div><button type="button" disabled={busy || !runtime.local_vision_enabled} onClick={() => void action({ action: "prepare" }, "正在提交本地视觉准备任务…")}>准备 / 启动</button><button type="button" className="secondary" disabled={busy || !runtime.vision.running} onClick={() => void action({ action: "stop" }, "正在停止本地视觉模型…")}>停止</button></div>
            </article>
            <article>
              <strong>人脸</strong><span>{runtimeStatusLabel(runtime.identity.face.status)}</span><small>{bytesLabel(runtime.identity.face.cache_bytes)}</small>
              {runtime.identity.face.last_error ? <em>{runtime.identity.face.last_error}</em> : null}
              <button type="button" disabled={busy || !runtime.face_identity_enabled || runtime.identity.face.preparing} onClick={() => void action({ action: "prepare_identity", kind: "face" }, "正在提交人脸运行时准备任务…")}>准备人脸模型</button>
            </article>
            <article>
              <strong>声纹</strong><span>{runtimeStatusLabel(runtime.identity.speaker.status)}</span><small>{bytesLabel(runtime.identity.speaker.cache_bytes)}</small>
              {runtime.identity.speaker.last_error ? <em>{runtime.identity.speaker.last_error}</em> : null}
              <button type="button" disabled={busy || !runtime.speaker_identity_enabled || runtime.identity.speaker.preparing} onClick={() => void action({ action: "prepare_identity", kind: "speaker" }, "正在提交声纹运行时准备任务…")}>准备声纹模型</button>
            </article>
          </div>
          <p className="production-note">模型和可选运行时只保存在当前设备。准备、下载、安装与模型加载通过可取消的设备任务进入状态中心；React 不下载模型，也不保存 embedding。</p>
        </>
      ) : null}
    </div>
  );
}
