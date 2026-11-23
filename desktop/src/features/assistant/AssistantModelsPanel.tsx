import { useEffect, useMemo, useState } from "react";
import {
  MODEL_ROUTING_CHANGED_EVENT,
  ModelSettingsClient,
  type AssistantModelsPayload,
  type EffectiveModelRoute,
  type EffectiveModelRouting,
  type ModelConnection,
  type ModelConnectionTestResult,
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

interface ProviderPreset {
  id: string;
  label: string;
  provider: string;
  base_url: string;
  models: Record<ModelRole, string>;
}

interface QuickConnectDraft {
  provider: string;
  base_url: string;
  model: string;
  api_key: string;
  has_api_key: boolean;
}

const PROVIDER_PRESETS: readonly ProviderPreset[] = [
  {
    id: "deepseek",
    label: "DeepSeek v4.1 (推荐)",
    provider: "openai-compatible",
    base_url: "https://api.deepseek.com/v1",
    models: {
      text: "deepseek-v4.1-flash",
      vision: "deepseek-v4.1-flash",
      embedding: "bge-m3",
    },
  },
  {
    id: "gemini",
    label: "Gemini",
    provider: "gemini",
    base_url: "https://generativelanguage.googleapis.com",
    models: {
      text: "gemini-2.5-flash",
      vision: "gemini-2.5-flash",
      embedding: "gemini-embedding-001",
    },
  },
  {
    id: "openai",
    label: "OpenAI",
    provider: "openai",
    base_url: "https://api.openai.com/v1",
    models: {
      text: "gpt-4.1-mini",
      vision: "gpt-4.1-mini",
      embedding: "text-embedding-3-large",
    },
  },
  {
    id: "local",
    label: "本地 Ollama",
    provider: "local",
    base_url: "http://127.0.0.1:11434/v1",
    models: {
      text: "qwen2.5:7b",
      vision: "qwen2.5vl:7b",
      embedding: "bge-m3",
    },
  },
];

const MCP_CONFIG = `{
  "mcpServers": {
    "mirrororder": {
      "command": "python3",
      "args": ["-m", "script_organizer.mcp_server"],
      "env": {
        "SCRIPT_ORGANIZER_URL": "http://127.0.0.1:8766",
        "SCRIPT_ORGANIZER_AGENT_TOKEN": "<从网关生成令牌>"
      }
    }
  }
}`;

const DEFAULT_QUICK_CONNECT: QuickConnectDraft = {
  provider: PROVIDER_PRESETS[0].provider,
  base_url: PROVIDER_PRESETS[0].base_url,
  model: PROVIDER_PRESETS[0].models.text,
  api_key: "",
  has_api_key: false,
};

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

function quickDraft(next: AssistantModelsPayload): QuickConnectDraft {
  const fallback = PROVIDER_PRESETS[0];
  const text = next.connections.text;
  const vision = next.connections.vision;
  const saved = text.base_url && text.model ? text : vision.base_url && vision.model ? vision : null;
  return {
    provider: saved?.provider || fallback.provider,
    base_url: saved?.base_url || fallback.base_url,
    model: saved?.model || fallback.models.text,
    api_key: "",
    has_api_key: Boolean(text.has_api_key || vision.has_api_key),
  };
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
  const [testingRole, setTestingRole] = useState<ModelRole | null>(null);
  const [testResults, setTestResults] = useState<Partial<Record<ModelRole, ModelConnectionTestResult>>>({});
  const [quickConnect, setQuickConnect] = useState<QuickConnectDraft>(DEFAULT_QUICK_CONNECT);
  const [quickPresetId, setQuickPresetId] = useState(PROVIDER_PRESETS[0].id);
  const [quickTesting, setQuickTesting] = useState(false);
  const [quickTestResult, setQuickTestResult] = useState<ModelConnectionTestResult | null>(null);
  const [mcpCopied, setMcpCopied] = useState(false);

  function applyPayload(next: AssistantModelsPayload): void {
    setPayload(next);
    setDrafts({
      text: draft(next.connections.text),
      vision: draft(next.connections.vision),
      embedding: draft(next.connections.embedding),
    });
    setQuickConnect(quickDraft(next));
    const quickSource = next.connections.text.base_url && next.connections.text.model ? next.connections.text : next.connections.vision;
    setQuickPresetId(PROVIDER_PRESETS.find((preset) => preset.provider === quickSource.provider
      && preset.base_url === quickSource.base_url
      && preset.models.text === quickSource.model)?.id ?? PROVIDER_PRESETS[0].id);
    setQuickTestResult(null);
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
    setTestResults((current) => {
      if (!current[role]) return current;
      const next = { ...current };
      delete next[role];
      return next;
    });
  }

  function applyPreset(role: ModelRole, preset: ProviderPreset): void {
    patch(role, {
      enabled: true,
      provider: preset.provider,
      base_url: preset.base_url,
      model: preset.models[role],
    });
  }

  function applyQuickPreset(preset: ProviderPreset): void {
    if (busy) return;
    setQuickPresetId(preset.id);
    setQuickConnect((current) => ({
      ...current,
      provider: preset.provider,
      base_url: preset.base_url,
      model: preset.models.text,
    }));
    setQuickTestResult(null);
  }

  function patchQuickConnect(value: Partial<QuickConnectDraft>): void {
    if (busy) return;
    setQuickConnect((current) => ({ ...current, ...value }));
    setQuickPresetId("custom");
    setQuickTestResult(null);
  }

  async function testRole(role: ModelRole): Promise<void> {
    if (busy || testingRole) return;
    const row = drafts[role];
    setTestingRole(role);
    try {
      const result = await client.test(role, {
        provider: row.provider,
        base_url: row.base_url,
        model: row.model,
        ...(row.api_key.trim() ? { api_key: row.api_key.trim() } : {}),
      });
      setTestResults((current) => ({ ...current, [role]: result }));
    } catch (error) {
      setTestResults((current) => ({
        ...current,
        [role]: {
          ok: false,
          role,
          provider: row.provider,
          model: row.model,
          status_code: 0,
          latency_ms: 0,
          detail: error instanceof Error ? error.message : String(error),
        },
      }));
    } finally {
      setTestingRole(null);
    }
  }

  async function testQuickConnection(): Promise<void> {
    if (busy || quickTesting || !quickConnect.base_url.trim() || !quickConnect.model.trim()) return;
    setQuickTesting(true);
    try {
      const result = await client.test("text", {
        provider: quickConnect.provider,
        base_url: quickConnect.base_url,
        model: quickConnect.model,
        ...(quickConnect.api_key.trim() ? { api_key: quickConnect.api_key.trim() } : {}),
      });
      setQuickTestResult(result);
    } catch (error) {
      setQuickTestResult({
        ok: false,
        role: "text",
        provider: quickConnect.provider,
        model: quickConnect.model,
        status_code: 0,
        latency_ms: 0,
        detail: error instanceof Error ? error.message : String(error),
      });
    } finally {
      setQuickTesting(false);
    }
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

  async function applyQuickSetup(): Promise<void> {
    if (!payload || busy || quickTesting || !quickConnect.base_url.trim() || !quickConnect.model.trim()) return;
    setBusy(true);
    setMessage("正在应用统一多模态连接…");
    try {
      const quickConnection: ModelConnectionWrite = {
        enabled: true,
        provider: quickConnect.provider,
        base_url: quickConnect.base_url.trim(),
        model: quickConnect.model.trim(),
      };
      if (quickConnect.api_key.trim()) quickConnection.api_key = quickConnect.api_key.trim();
      const embedding = payload.connections.embedding;
      const next = await client.save({
        text: { ...quickConnection },
        vision: { ...quickConnection },
        embedding: {
          enabled: embedding.enabled,
          provider: embedding.provider || "openai-compatible",
          base_url: embedding.base_url,
          model: embedding.model,
        },
      });
      applyPayload(next);
      setMessage("");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(false);
    }
  }

  async function copyMcpConfig(): Promise<void> {
    try {
      await navigator.clipboard.writeText(MCP_CONFIG);
      setMcpCopied(true);
      globalThis.setTimeout(() => setMcpCopied(false), 1800);
    } catch {
      setMcpCopied(false);
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
          <section className="assistant-quick-connect" aria-labelledby="assistant-quick-connect-title">
            <div className="assistant-quick-connect-heading">
              <div>
                <p className="eyebrow">统一接入</p>
                <h4 id="assistant-quick-connect-title">一键接入主力多模态模型</h4>
                <p>填写一套连接，同时用于小镜对话与场记 PDF/照片识图（向量检索默认走本机零成本关键词召回）</p>
              </div>
              <span className="assistant-quick-connect-badge">对话 + 识图</span>
            </div>
            <div className="assistant-quick-presets" role="group" aria-label="统一多模态模型预设">
              {PROVIDER_PRESETS.map((preset) => (
                <button
                  key={preset.id}
                  type="button"
                  className={`assistant-preset-pill ${quickPresetId === preset.id ? "is-active" : ""}`}
                  disabled={busy || quickTesting}
                  aria-pressed={quickPresetId === preset.id}
                  onClick={() => applyQuickPreset(preset)}
                >
                  {preset.label}
                </button>
              ))}
            </div>
            <div className="assistant-quick-connect-grid">
              <label className="production-field"><span>提供方</span><select value={quickConnect.provider} disabled={busy || quickTesting} onChange={(event) => patchQuickConnect({ provider: event.target.value })}><option value="openai-compatible">OpenAI-compatible</option><option value="gemini">Gemini</option><option value="openai">OpenAI</option><option value="local">本地 Ollama</option></select></label>
              <label className="production-field"><span>服务地址</span><input value={quickConnect.base_url} disabled={busy || quickTesting} onChange={(event) => patchQuickConnect({ base_url: event.target.value })} spellCheck={false} /></label>
              <label className="production-field"><span>模型名</span><input value={quickConnect.model} disabled={busy || quickTesting} onChange={(event) => patchQuickConnect({ model: event.target.value })} spellCheck={false} /></label>
              <label className="production-field"><span>API Key</span><input type="password" value={quickConnect.api_key} disabled={busy || quickTesting} onChange={(event) => patchQuickConnect({ api_key: event.target.value })} placeholder={quickConnect.has_api_key ? "已保存；留空保持不变" : "粘贴 API Key（仅保存在本机）"} autoComplete="off" /></label>
            </div>
            <div className="assistant-quick-connect-actions">
              <div className="assistant-quick-connect-feedback" role="status">
                {quickTestResult ? <span className={quickTestResult.ok ? "is-ok" : "is-error"}>{quickTestResult.ok ? "✓ " : "✕ "}{quickTestResult.detail}</span> : <span>文本连接测试会使用上面的地址、模型和 Key。</span>}
              </div>
              <div className="assistant-quick-connect-buttons">
                <button type="button" className="secondary" disabled={busy || quickTesting || !quickConnect.base_url.trim() || !quickConnect.model.trim()} onClick={() => void testQuickConnection()}>{quickTesting ? "测试中…" : "测试连通"}</button>
                <button type="button" className="assistant-quick-connect-primary" disabled={busy || quickTesting || !payload || !quickConnect.base_url.trim() || !quickConnect.model.trim()} onClick={() => void applyQuickSetup()}>应用到对话与识图</button>
              </div>
            </div>
          </section>
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
                    <div className="model-preset-strip" role="group" aria-label={`${label}快速预设`}>
                      {PROVIDER_PRESETS.map((preset) => (
                        <button key={preset.id} type="button" className="secondary" disabled={busy} onClick={() => applyPreset(role, preset)}>
                          {preset.label}
                        </button>
                      ))}
                    </div>
                    <label className="production-field"><span>提供方</span><select value={row.provider} disabled={busy} onChange={(event) => patch(role, { provider: event.target.value })}><option value="gemini">Google Gemini（原生 API）</option><option value="openai">OpenAI</option><option value="openai-compatible">OpenAI-compatible</option><option value="local">{role === "vision" ? "本机视觉语义" : "本机服务"}</option><option value="llama.cpp">llama.cpp</option><option value="llama-server">llama-server</option></select></label>
                    <label className="production-field"><span>服务地址</span><input value={row.base_url} disabled={busy} onChange={(event) => patch(role, { base_url: event.target.value })} placeholder="https://generativelanguage.googleapis.com 或 https://api.openai.com/v1" /></label>
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
                      <button type="button" className="secondary" disabled={busy || testingRole !== null || !row.base_url.trim()} onClick={() => void testRole(role)}>
                        {testingRole === role ? "测试中…" : "测试连通"}
                      </button>
                    </div>
                    {testResults[role] ? (
                      <p className={`model-test-status ${testResults[role]!.ok ? "is-ok" : "is-error"}`} role="status">
                        {testResults[role]!.ok ? "✓ " : "✕ "}{testResults[role]!.detail}
                      </p>
                    ) : null}
                  </section>
                );
              })}
            </div>
            <button type="button" disabled={busy || !payload || !dirty} onClick={() => void save()}>{busy ? "保存中…" : "保存高级模型设置"}</button>
            <p className="production-note">这些覆盖属于当前设备，不属于某个项目。关闭覆盖后，小镜立即回到自动选择路径。</p>
          </details>
          <details className="assistant-mcp-connect">
            <summary>
              <span>外部 Agent 接入（MCP）</span>
              <small>供 ChatGPT / Claude / Codex / Cursor 安全只读接入</small>
            </summary>
            <p className="production-note">通过镜序内置 MCP Server（受权限网关保护，仅检索与提议，不可改写同步母版），无需共享网页账号。</p>
            <div className="assistant-mcp-toolbar">
              <pre aria-label="MCP 配置">{MCP_CONFIG}</pre>
              <button type="button" className="secondary" onClick={() => void copyMcpConfig()}>{mcpCopied ? "已复制" : "复制 MCP 配置"}</button>
            </div>
          </details>
        </>
      ) : null}
    </div>
  );
}
