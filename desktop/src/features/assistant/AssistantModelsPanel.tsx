import { useEffect, useMemo, useState } from "react";
import {
  MODEL_ROUTING_CHANGED_EVENT,
  ModelSettingsClient,
  type AssistantModelsPayload,
  type EffectiveModelRoute,
  type EffectiveModelRouting,
  type ModelConnection,
  type ModelConnectionWrite,
  type ModelRole,
  type ModelRoutingMode,
} from "../../api/models";

interface Props {
  baseUrl: string;
}

interface Draft extends ModelConnectionWrite {
  has_api_key: boolean;
  api_key: string;
  clear_api_key: boolean;
}

const ROLES: Array<{ role: ModelRole; label: string; description: string }> = [
  { role: "text", label: "对话与推理", description: "覆盖小镜自动选择的语言模型" },
  { role: "vision", label: "画面理解", description: "覆盖自动选择的多模态视觉模型" },
  { role: "embedding", label: "向量检索", description: "覆盖项目证据的语义向量编码器；本地方案可用 llama-server / Ollama 等提供 OpenAI 兼容 /embeddings 端点（如 bge-m3）" },
];

const CAPABILITY_LABELS: Record<ModelRole, string> = {
  text: "对话与推理",
  vision: "画面理解",
  embedding: "语义检索",
};

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
  return enabled ? `${enabled} 项能力覆盖已启用` : "当前使用自动调度";
}

function modeLabel(mode: ModelRoutingMode): string {
  return {
    local: "本地",
    external: "外部",
    hybrid: "混合",
    fallback: "基础模式",
  }[mode];
}

function routeValue(role: ModelRole, row: EffectiveModelRoute): string {
  if (role === "embedding" && !row.enabled && row.fallback === "keyword") return "关键词检索";
  if (!row.enabled) return "未启用模型";
  const parts = [row.local ? "本地" : "外部"];
  if (!row.local && row.provider && row.provider !== "none") parts.push(row.provider);
  if (row.model) parts.push(row.model);
  return parts.join(" · ");
}

function routeNote(role: ModelRole, row: EffectiveModelRoute): string {
  if (role === "embedding" && !row.enabled && row.fallback === "keyword") return "未启用向量模型；继续使用本机 FTS / 关键词召回";
  if (!row.enabled) return role === "vision" ? "当前不调用视觉模型" : "当前不调用语言模型";
  if (row.source === "local-vision-text-fallback") return "自动沿用已启用的本地多模态模型";
  if (row.source === "device-model-connection") return "由高级模型设置覆盖自动选择";
  if (row.source === "assistant-env" || row.source === "embedding-env") return "由当前 Host 环境配置覆盖";
  if (row.source === "production-rescue") return "沿用生产模型后备配置";
  return row.local ? "在当前设备执行" : "通过已配置的模型服务执行";
}

function privacySummary(routing: EffectiveModelRouting): string {
  const externalRoles = (Object.entries({ text: routing.text, vision: routing.vision, embedding: routing.embedding }) as Array<[ModelRole, EffectiveModelRoute]>)
    .filter(([, row]) => row.enabled && !row.local)
    .map(([role]) => CAPABILITY_LABELS[role]);
  if (routing.privacy === "local-only") {
    return routing.mode === "fallback"
      ? "当前没有启用模型服务；语义检索使用本机关键词回退，不会调用外部模型。"
      : "当前启用的模型能力均在本机执行，不会调用外部模型服务。";
  }
  const roles = externalRoles.join("、") || "已启用能力";
  return routing.privacy === "mixed"
    ? `混合运行：${roles}会调用外部模型服务，其余能力保持本机执行或关键词回退。`
    : `外部运行：${roles}会调用已配置的外部模型服务。`;
}

export function AssistantModelsPanel({ baseUrl }: Props) {
  const client = useMemo(() => new ModelSettingsClient(baseUrl), [baseUrl]);
  const [payload, setPayload] = useState<AssistantModelsPayload | null>(null);
  const [drafts, setDrafts] = useState<Record<ModelRole, Draft>>(emptyDraft);
  const [message, setMessage] = useState("正在读取小镜实际运行方式…");
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
    const refreshRouting = () => {
      void client.read().then((next) => {
        if (cancelled) return;
        setPayload((current) => current ? { ...next, connections: current.connections } : next);
        setMessage("");
      }).catch((error: unknown) => {
        if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
      });
    };
    void client.read().then((next) => {
      if (cancelled) return;
      applyPayload(next);
      setMessage("");
    }).catch((error: unknown) => {
      if (!cancelled) setMessage(error instanceof Error ? error.message : String(error));
    });
    globalThis.addEventListener(MODEL_ROUTING_CHANGED_EVENT, refreshRouting);
    return () => {
      cancelled = true;
      globalThis.removeEventListener(MODEL_ROUTING_CHANGED_EVENT, refreshRouting);
    };
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
    setMessage("正在保存高级模型设置…");
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
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="production-panel model-connections-card assistant-routing-card">
      <div className="assistant-routing-heading">
        <div><p className="eyebrow">自动调度</p><h3>小镜当前运行方式</h3></div>
        {payload ? <span className={`assistant-routing-mode mode-${payload.routing.mode}`}>{modeLabel(payload.routing.mode)}</span> : null}
      </div>

      {message ? <p className="production-note assistant-routing-message">{message}</p> : null}
      {payload ? (
        <>
          <div className="assistant-routing-grid">
            {(Object.entries(CAPABILITY_LABELS) as Array<[ModelRole, string]>).map(([role, label]) => {
              const row = payload.routing[role];
              return (
                <article className="assistant-route" key={role}>
                  <span>{label}</span>
                  <strong>{routeValue(role, row)}</strong>
                  <small>{routeNote(role, row)}</small>
                </article>
              );
            })}
          </div>
          <p className="production-note assistant-routing-privacy">{privacySummary(payload.routing)}</p>
          {payload.routing.vision.enabled && !payload.routing.vision.local ? <p className="production-note assistant-routing-privacy">外部画面理解只发送抽样帧到所选服务，不上传原始视频文件。</p> : null}
          {payload.restore_error ? <p className="production-warning">上次设备模型自动恢复未完成：{payload.restore_error}</p> : null}

          <details className="assistant-models">
            <summary>
              <span>高级模型设置</span>
              <small>{connectionSummary(payload)}</small>
            </summary>
            <p className="production-note">默认保持自动调度。只有需要强制覆盖某项能力时才配置这里；API Key 只保存在当前设备，不会回显。</p>
            <div className="assistant-model-grid">
              {ROLES.map(({ role, label, description }) => {
                const row = drafts[role];
                return (
                  <section className="assistant-model-role" key={role}>
                    <div className="assistant-model-heading">
                      <div><strong>{label}</strong><small>{description}</small></div>
                      <label><input type="checkbox" checked={row.enabled} disabled={busy} onChange={(event) => patch(role, { enabled: event.target.checked })} />启用覆盖</label>
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
            <button type="button" disabled={busy || !payload || !dirty} onClick={() => void save()}>{busy ? "保存中…" : "保存高级模型设置"}</button>
            <p className="production-note">这些覆盖属于当前设备，不属于某个项目。关闭覆盖后，小镜立即回到自动选择路径。</p>
          </details>
        </>
      ) : null}
    </div>
  );
}
