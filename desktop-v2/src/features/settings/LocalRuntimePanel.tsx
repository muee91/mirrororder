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

export function LocalRuntimePanel({ baseUrl }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [runtime, setRuntime] = useState<LocalRuntimePayload | null>(null);
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取本地智能运行时…");

  async function reload(): Promise<void> {
    try {
      const next = await client.localRuntime();
      setRuntime(next);
      setModel(next.local_vision_model);
      setMessage(`local_runtime.v1 · vision ${next.vision.status} · face ${next.identity.face.status} · speaker ${next.identity.speaker.status}`);
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
      setMessage(`运行时已更新 · vision ${next.vision.status} · face ${next.identity.face.status} · speaker ${next.identity.speaker.status}`);
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
          <p className="eyebrow">Device-local Intelligence Runtime</p>
          <h3>本地模型 / 身份运行时</h3>
        </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button>
      </div>
      <p className="production-note">{message}</p>
      {runtime ? (
        <>
          <div className="runtime-switch-grid">
            <label className="settings-check">
              <input type="checkbox" checked={runtime.local_vision_enabled} disabled={busy} onChange={(event) => void action({ action: "set", local_vision_enabled: event.target.checked }, "正在更新本地视觉开关…")} />
              <span>本地视觉</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={runtime.face_identity_enabled} disabled={busy} onChange={(event) => void action({ action: "set", face_identity_enabled: event.target.checked }, "正在更新人脸身份开关…")} />
              <span>人脸身份</span>
            </label>
            <label className="settings-check">
              <input type="checkbox" checked={runtime.speaker_identity_enabled} disabled={busy} onChange={(event) => void action({ action: "set", speaker_identity_enabled: event.target.checked }, "正在更新说话人身份开关…")} />
              <span>说话人身份</span>
            </label>
          </div>
          <div className="runtime-model-row">
            <label className="production-field">
              <span>本地视觉模型</span>
              <input value={model} onChange={(event) => setModel(event.target.value)} spellCheck={false} />
            </label>
            <button type="button" className="secondary" disabled={busy || !model.trim() || model.trim() === runtime.local_vision_model} onClick={() => void action({ action: "set", local_vision_model: model.trim() }, "正在切换本地视觉模型…")}>保存模型</button>
          </div>
          <div className="runtime-status-grid">
            <article>
              <strong>Vision</strong><span>{runtime.vision.status}</span><small>{bytesLabel(runtime.vision.cache_bytes)} · {runtime.vision.available ? "runtime available" : "llama-server missing"}</small>
              {runtime.vision.last_error ? <em>{runtime.vision.last_error}</em> : null}
              <div><button type="button" disabled={busy || !runtime.local_vision_enabled} onClick={() => void action({ action: "prepare" }, "正在后台准备本地视觉模型…")}>准备 / 启动</button><button type="button" className="secondary" disabled={busy || !runtime.vision.running} onClick={() => void action({ action: "stop" }, "正在停止本地视觉模型…")}>停止</button></div>
            </article>
            <article>
              <strong>Face</strong><span>{runtime.identity.face.status}</span><small>{bytesLabel(runtime.identity.face.cache_bytes)}</small>
              {runtime.identity.face.last_error ? <em>{runtime.identity.face.last_error}</em> : null}
              <button type="button" disabled={busy || !runtime.face_identity_enabled || runtime.identity.face.preparing} onClick={() => void action({ action: "prepare_identity", kind: "face" }, "正在后台准备人脸识别运行时…")}>准备人脸模型</button>
            </article>
            <article>
              <strong>Speaker</strong><span>{runtime.identity.speaker.status}</span><small>{bytesLabel(runtime.identity.speaker.cache_bytes)}</small>
              {runtime.identity.speaker.last_error ? <em>{runtime.identity.speaker.last_error}</em> : null}
              <button type="button" disabled={busy || !runtime.speaker_identity_enabled || runtime.identity.speaker.preparing} onClick={() => void action({ action: "prepare_identity", kind: "speaker" }, "正在后台准备说话人识别运行时…")}>准备说话人模型</button>
            </article>
          </div>
          <p className="production-note">模型与 optional Python wheels 都是当前设备状态。准备动作由现有 Python runtime 后台执行；React 不下载模型、不保存 embedding。</p>
        </>
      ) : null}
    </div>
  );
}
