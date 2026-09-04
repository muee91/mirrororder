import { useEffect, useMemo, useState } from "react";
import { ModelSettingsClient, type AssistantModelsPayload, type ModelConnection, type ModelConnectionWrite, type ModelRole } from "../../api/models";

interface Props {
  baseUrl: string;
}

interface Draft extends ModelConnectionWrite {
  has_api_key: boolean;
  api_key: string;
  clear_api_key: boolean;
}

const ROLES: Array<{ role: ModelRole; label: string; description: string }> = [
  { role: "text", label: "语言模型", description: "小镜的语言解释与受限规划" },
  { role: "vision", label: "视觉模型", description: "画面理解与多模态增强" },
  { role: "embedding", label: "语义检索", description: "项目证据的向量检索编码" },
];

function draft(row: ModelConnection): Draft {
  return {
    enabled: row.enabled,
    provider: row.provider || "openai-compatible",
    base_url: row.base_url,
    model: row.model,
    has_api_key: row.has_api_key,
    api_key: "",
    clear_api_key: false,
  };
}

function emptyDraft(): Record<ModelRole, Draft> {
  const base: Draft = { enabled: false, provider: "openai-compatible", base_url: "", model: "", has_api_key: false, api_key: "", clear_api_key: false };
  return { text: { ...base }, vision: { ...base }, embedding: { ...base } };
}

function connectionSummary(next: AssistantModelsPayload): string {
  const enabled = ROLES.filter(({ role }) => next.connections[role].enabled).length;
  return enabled ? `${enabled} 类设备模型连接已启用` : "当前设备没有启用外部 / 自定义模型连接";
}

export function AssistantModelsPanel({ baseUrl }: Props) {
  const client = useMemo(() => new ModelSettingsClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<AssistantModelsPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<ModelRole, Draft>>(emptyDraft);
  const [message, setMessage] = useState("正在读取当前设备的模型连接…");
  const [busy, setBusy] = useState(false);

  function applyPayload(next: AssistantModelsPayload): void {
    setPayload(next);
    setDrafts({
      text: draft(next.connections.text),
      vision: draft(next.connections.vision),
      embedding: draft(next.connections.embedding),
    });
  }

  useEffect(() => {
    let cancelled = false;
    void client.read().then((next) => {
      if (cancelled) return;
      applyPayload(next);
      setMessage(connectionSummary(next));
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [client]);

  function patch(role: ModelRole, value: Partial<Draft>): void {
    if (busy) return;
    setDrafts((current) => ({ ...current, [role]: { ...current[role], ...value } }));
  }

  const dirty = Boolean(payload && ROLES.some(({ role }) => {
    const row = drafts[role];
    const saved = payload.connections[role];
    return row.enabled !== saved.enabled
      || row.provider !== (saved.provider || "openai-compatible")
      || row.base_url !== saved.base_url
      || row.model !== saved.model
      || Boolean(row.api_key.trim())
      || row.clear_api_key;
  }));

  async function save(): Promise<void> {
    if (!payload || !dirty || busy) return;
    setBusy(true);
    setMessage("正在保存当前设备的模型连接…");
    try {
      const writes = Object.fromEntries(ROLES.map(({ role }) => {
        const row = drafts[role];
        const value: ModelConnectionWrite = {
          enabled: row.enabled,
          provider: row.provider,
          base_url: row.base_url,
          model: row.model,
        };
        if (row.api_key.trim()) value.api_key = row.api_key.trim();
        else if (row.clear_api_key) value.api_key = "";
        return [role, value];
      })) as Record<ModelRole, ModelConnectionWrite>;
      const next = await client.save(writes);
      applyPayload(next);
      setMessage(connectionSummary(next));
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="assistant-models production-panel model-connections-card">
      <summary>
        <span>外部 / 自定义模型连接</span>
        <small>{message}</small>
      </summary>
      {payload?.restore_error ? <p className="production-warning">上次设备模型自动恢复未完成：{payload.restore_error}</p> : null}
      {payload ? (
        <div className="assistant-model-grid">
          {ROLES.map(({ role, label, description }) => {
            const row = drafts[role];
            return (
              <section className="assistant-model-role" key={role}>
                <div className="assistant-model-heading">
                  <div><strong>{label}</strong><small>{description}</small></div>
                  <label><input type="checkbox" checked={row.enabled} disabled={busy} onChange={(event) => patch(role, { enabled: event.target.checked })} />启用</label>
                </div>
                <label className="production-field"><span>提供方</span><select value={row.provider} disabled={busy} onChange={(event) => patch(role, { provider: event.target.value })}><option value="openai-compatible">OpenAI-compatible</option><option value="openai">OpenAI</option><option value="local">本机服务</option><option value="llama.cpp">llama.cpp</option><option value="llama-server">llama-server</option></select></label>
                <label className="production-field"><span>服务地址</span><input value={row.base_url} disabled={busy} onChange={(event) => patch(role, { base_url: event.target.value })} placeholder="http://127.0.0.1:... 或兼容 API" /></label>
                <label className="production-field"><span>模型</span><input value={row.model} disabled={busy} onChange={(event) => patch(role, { model: event.target.value })} /></label>
                <div className="model-api-key-row">
                  <label className="production-field">
                    <span>API Key</span>
                    <input
                      type="password"
                      value={row.api_key}
                      disabled={busy}
                      onChange={(event) => patch(role, { api_key: event.target.value, clear_api_key: false })}
                      placeholder={row.clear_api_key ? "保存后删除已存 Key" : row.has_api_key ? "已保存；留空保持不变" : "可选；不会回显"}
                    />
                  </label>
                  {row.has_api_key ? (
                    <button type="button" className="secondary" disabled={busy} onClick={() => patch(role, { api_key: "", clear_api_key: !row.clear_api_key })}>
                      {row.clear_api_key ? "保留已保存 Key" : "清除已保存 Key"}
                    </button>
                  ) : null}
                </div>
              </section>
            );
          })}
        </div>
      ) : <p className="production-note">{message}</p>}
      <button type="button" disabled={busy || !payload || !dirty} onClick={() => void save()}>{busy ? "保存中…" : "保存模型连接"}</button>
      <p className="production-note">这些连接属于当前设备，不属于某个项目。切换项目不会要求重新启用；密钥保存在设备 secret store。</p>
    </details>
  );
}
