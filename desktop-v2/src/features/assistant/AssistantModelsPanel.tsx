import { useEffect, useMemo, useState } from "react";
import { ModelSettingsClient, type AssistantModelsPayload, type ModelConnection, type ModelConnectionWrite, type ModelRole } from "../../api/models";

interface Props {
  baseUrl: string;
  projectId: string;
}

interface Draft extends ModelConnectionWrite {
  has_api_key: boolean;
  api_key: string;
}

const ROLES: Array<{ role: ModelRole; label: string }> = [
  { role: "text", label: "语言 / 小镜" },
  { role: "vision", label: "视觉 / 多模态" },
  { role: "embedding", label: "语义检索" },
];

function draft(row: ModelConnection): Draft {
  return {
    enabled: row.enabled,
    provider: row.provider || "openai-compatible",
    base_url: row.base_url,
    model: row.model,
    has_api_key: row.has_api_key,
    api_key: "",
  };
}

function emptyDraft(): Record<ModelRole, Draft> {
  const base: Draft = { enabled: false, provider: "openai-compatible", base_url: "", model: "", has_api_key: false, api_key: "" };
  return { text: { ...base }, vision: { ...base }, embedding: { ...base } };
}

export function AssistantModelsPanel({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new ModelSettingsClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<AssistantModelsPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<ModelRole, Draft>>(emptyDraft);
  const [message, setMessage] = useState("正在读取本机模型连接…");
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
    void client.read(projectId).then((next) => {
      if (cancelled) return;
      applyPayload(next);
      setMessage(`models.v1 · device-local connections v${next.connections.version}`);
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
    });
    return () => { cancelled = true; };
  }, [client, projectId]);

  function patch(role: ModelRole, value: Partial<Draft>): void {
    setDrafts((current) => ({ ...current, [role]: { ...current[role], ...value } }));
  }

  async function save(): Promise<void> {
    setBusy(true);
    setMessage("正在保存设备本机模型连接…");
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
        return [role, value];
      })) as Record<ModelRole, ModelConnectionWrite>;
      const next = await client.save(projectId, writes);
      applyPayload(next);
      setMessage("模型连接已保存；API key 仍只保存在设备 secret store 文件，不回显到 UI。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="assistant-models production-panel">
      <summary>模型与连接 · Desktop only</summary>
      <p className="production-note">{message}</p>
      {payload ? (
        <div className="assistant-model-grid">
          {ROLES.map(({ role, label }) => {
            const row = drafts[role];
            return (
              <section className="assistant-model-role" key={role}>
                <div className="assistant-model-heading">
                  <strong>{label}</strong>
                  <label><input type="checkbox" checked={row.enabled} onChange={(event) => patch(role, { enabled: event.target.checked })} />启用</label>
                </div>
                <label className="production-field"><span>Provider</span><select value={row.provider} onChange={(event) => patch(role, { provider: event.target.value })}><option value="openai-compatible">OpenAI-compatible</option><option value="openai">OpenAI</option><option value="local">Local</option><option value="llama.cpp">llama.cpp</option><option value="llama-server">llama-server</option></select></label>
                <label className="production-field"><span>Base URL</span><input value={row.base_url} onChange={(event) => patch(role, { base_url: event.target.value })} placeholder="http://127.0.0.1:... 或兼容 API" /></label>
                <label className="production-field"><span>Model</span><input value={row.model} onChange={(event) => patch(role, { model: event.target.value })} /></label>
                <label className="production-field"><span>API Key</span><input type="password" value={row.api_key} onChange={(event) => patch(role, { api_key: event.target.value })} placeholder={row.has_api_key ? "已保存；留空保持不变" : "可选；不会回显"} /></label>
              </section>
            );
          })}
        </div>
      ) : null}
      <button type="button" disabled={busy || !payload} onClick={() => void save()}>保存模型连接</button>
    </details>
  );
}
