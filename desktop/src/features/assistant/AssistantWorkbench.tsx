import { useEffect, useMemo, useState } from "react";
import { errorMessage } from "../../api/host";
import { ProductionClient, type AssistantAnswer, type AssistantItem, type AssistantStatus } from "../../api/production";

interface Props {
  baseUrl: string;
  projectId: string;
  onFocusTake?: (groupId: string, destination?: "material" | "script" | "review") => void;
}

const SOURCE_LABELS: Record<string, string> = {
  visual: "画面",
  speech: "对白",
  slate: "场记",
};

interface RetrievalResult {
  group_id?: string;
  source?: string;
  source_label?: string;
  snippet?: string;
  start?: number;
}

function retrievalResults(answer: AssistantAnswer | null): RetrievalResult[] {
  const retrieval = answer?.retrieval as { results?: unknown } | undefined;
  const results = Array.isArray(retrieval?.results) ? retrieval.results : [];
  return results.filter((row): row is RetrievalResult => Boolean(row) && typeof row === "object");
}

function itemActions(item: AssistantItem): string[] {
  const actions = item.actions;
  return Array.isArray(actions) ? actions.filter((value): value is string => typeof value === "string") : [];
}

function itemText(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function answerText(answer: AssistantAnswer | null): string {
  if (!answer) return "";
  return String(answer.answer ?? answer.message ?? answer.text ?? "");
}

function itemKindLabel(value: unknown): string {
  return {
    decision: "需要判断",
    production: "制作提醒",
    people: "人物线索",
    attention: "需要留意",
  }[String(value ?? "")] ?? "项目事项";
}

export function AssistantWorkbench({ baseUrl, projectId, onFocusTake }: Props) {
  const client = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [message, setMessage] = useState("正在读取项目关注事项…");
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    setMessage("正在读取项目关注事项…");
    try {
      const next = await client.assistant(projectId);
      setStatus(next);
      setMessage(next.items?.length ? `${next.items.length} 个项目事项` : "当前没有需要特别关注的事项");
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void reload();
    // client is stable for baseUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId]);

  async function cycle(): Promise<void> {
    setBusy(true);
    setMessage("正在重新检查当前项目…");
    try {
      const next = await client.cycleAssistant(projectId, true);
      setStatus(next);
      setMessage(next.items?.length ? `已更新 · ${next.items.length} 个项目事项` : "已更新 · 当前没有需要特别关注的事项");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function ask(): Promise<void> {
    if (!prompt.trim()) return;
    setBusy(true);
    setMessage("小镜正在基于当前项目证据回答…");
    try {
      const response = await client.messageAssistant(projectId, prompt);
      setAnswer(response);
      setMessage("回答完成；任何生产结论仍由你确认。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="phase3-workbench">
      <header className="production-heading">
        <div>
          <p className="eyebrow">当前项目</p>
          <h2>小镜</h2>
        </div>
        <div className="assistant-heading-actions">
          <span className="production-state">{message}</span>
          <button type="button" className="secondary" disabled={busy} onClick={() => void cycle()}>重新检查</button>
        </div>
      </header>

      <div className="production-grid assistant-grid">
        <div className="production-panel">
          <p className="eyebrow">关注事项</p>
          <h3>{status?.summary || "当前没有摘要"}</h3>
          <div className="assistant-items">
            {(status?.items ?? []).length ? (status?.items ?? []).slice(0, 18).map((item, index) => {
              const groupId = typeof item.group_id === "string" ? item.group_id : "";
              const actions = itemActions(item);
              return (
                <article className="assistant-item" key={String(item.item_id ?? `${item.kind ?? "item"}-${index}`)}>
                  <div>
                    <span>{itemKindLabel(item.kind ?? item.status)}</span>
                    <strong>{String(item.title ?? "项目事项")}</strong>
                  </div>
                  <em>{Number(item.priority ?? 0) >= 80 ? "优先" : ""}</em>
                  {itemText(item.message) ? <p className="assistant-item-message">{itemText(item.message)}</p> : null}
                  {itemText(item.context) ? <p className="assistant-item-context">{itemText(item.context)}</p> : null}
                  {groupId && actions.length && onFocusTake ? (
                    <div className="assistant-item-actions">
                      {actions.includes("focus") ? (
                        <button type="button" className="secondary" onClick={() => onFocusTake(groupId, "material")}>定位 Take</button>
                      ) : null}
                      {actions.includes("placement") ? (
                        <button type="button" onClick={() => onFocusTake(groupId, "script")}>去剧本归集</button>
                      ) : null}
                    </div>
                  ) : null}
                </article>
              );
            }) : <p className="empty-copy">当前没有需要小镜突出显示的事项。</p>}
          </div>
        </div>

        <aside className="production-panel assistant-chat">
          <p className="eyebrow">项目对话</p>
          <textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：哪些场还缺明确 Best？场记 NG 与当前选择有没有冲突？" />
          <button type="button" disabled={busy || !prompt.trim()} onClick={() => void ask()}>询问小镜</button>
          {answer ? (
            <div className="assistant-answer">
              <p>{answerText(answer) || JSON.stringify(answer, null, 2)}</p>
              {retrievalResults(answer).length ? (
                <div className="assistant-answer-evidence">
                  <p className="eyebrow">证据引用 · 点击定位到看片</p>
                  {retrievalResults(answer).slice(0, 6).map((row, index) => (
                    <button
                      type="button"
                      key={`${row.group_id ?? "doc"}-${index}`}
                      disabled={!row.group_id || !onFocusTake}
                      onClick={() => { if (row.group_id && onFocusTake) onFocusTake(row.group_id, "review"); }}
                    >
                      <span className="assistant-evidence-source">{SOURCE_LABELS[row.source ?? ""] ?? row.source_label ?? "证据"}</span>
                      <small>{row.snippet || "没有可显示的片段"}</small>
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          <p className="production-note">小镜只分析已有项目证据并提出建议；不会直接写入人工审核、最终剪辑决定或交付结果。</p>
        </aside>
      </div>
    </section>
  );
}
