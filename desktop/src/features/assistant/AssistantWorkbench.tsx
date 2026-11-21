import { useEffect, useMemo, useRef, useState } from "react";
import { canOpenEvidence, type EvidenceReference } from "../production/evidenceLocation";
import { errorMessage } from "../../api/host";
import { ProductionClient, type AssistantAnswer, type AssistantItem, type AssistantQuestionContext, type AssistantStatus } from "../../api/production";

interface Props {
  baseUrl: string;
  projectId: string;
  draft: { text: string; includeSelection: boolean };
  readContext: (includeSelection: boolean) => AssistantQuestionContext;
  onOpenEvidence: (reference: EvidenceReference) => void;
  onOpenDiagnostic: (page: "sync-task" | "media-binding" | "sync-delivery") => void;
  onFocusTake?: (groupId: string, destination?: "material" | "script" | "review", clipId?: string) => void;
}

const SOURCE_LABELS: Record<string, string> = {
  visual: "画面",
  speech: "对白",
  slate: "场记",
};

type RetrievalResult = EvidenceReference & { source_label?: string };
type AssistantTurn = {
  id: string;
  role: "user" | "assistant";
  text: string;
  answer?: AssistantAnswer;
};

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

export function AssistantWorkbench({ baseUrl, projectId, draft, readContext, onOpenDiagnostic, onOpenEvidence, onFocusTake }: Props) {
  const client = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [prompt, setPrompt] = useState(draft.text);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [message, setMessage] = useState("正在读取项目关注事项…");
  const [busy, setBusy] = useState(false);
  const [includeSelection, setIncludeSelection] = useState(draft.includeSelection);
  const interacted = useRef(false);
  const threadEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let active = true;
    void client.assistant(projectId).then((next) => {
      if (!active) return;
      if (interacted.current) {
        setStatus((current) => current ?? next);
        return;
      }
      setStatus(next);
      const history = (next.messages ?? []).slice(-12).map((item, index): AssistantTurn => ({
        id: `hist-${index}`,
        role: item.role === "user" ? "user" : "assistant",
        text: item.text,
        answer: item.role === "assistant" && item.context ? { answer: item.text, context: item.context } : undefined,
      }));
      if (history.length) setTurns((current) => (current.length ? current : history));
      setMessage(next.items?.length ? `${next.items.length} 个项目事项` : "");
    }).catch((error) => { if (active && !interacted.current) setMessage(errorMessage(error)); });
    return () => { active = false; };
  }, [client, projectId]);

  useEffect(() => {
    threadEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [turns.length]);

  async function cycle(): Promise<void> {
    interacted.current = true;
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
    const question = prompt.trim();
    if (!question || busy) return;
    interacted.current = true;
    const context = readContext(includeSelection);
    setTurns((current) => [...current, { id: `u-${Date.now()}-${current.length}`, role: "user", text: question }]);
    draft.text = "";
    setPrompt("");
    setBusy(true);
    setMessage("小镜正在基于当前项目证据回答…");
    try {
      const response = await client.messageAssistant(projectId, question, context);
      setTurns((current) => [
        ...current,
        {
          id: `a-${Date.now()}-${current.length}`,
          role: "assistant",
          text: answerText(response) || "小镜未返回可阅读的回答。",
          answer: response,
        },
      ]);
      setMessage("");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="assistant-workbench">
      <div className="assistant-chat">
        <div className="assistant-chat-header">
          <label className="assistant-scope-field">
            <span>范围</span>
            <select value={includeSelection ? "selection" : "project"} onChange={(event) => {
              draft.includeSelection = event.target.value === "selection";
              setIncludeSelection(draft.includeSelection);
            }}>
              <option value="selection">当前页面与选区</option>
              <option value="project">整个项目</option>
            </select>
          </label>
          {message ? <span className="production-state" role="status">{message}</span> : null}
        </div>

        <div className="assistant-thread" aria-live="polite">
          {turns.length ? turns.map((turn) => (
            <div key={turn.id} className={`assistant-turn is-${turn.role}`}>
              {turn.role === "user" ? (
                <div className="assistant-user-bubble">{turn.text}</div>
              ) : (
                <div className="assistant-answer">
                  {turn.answer?.context && <strong>{turn.answer.context.label}</strong>}
                  <p>{turn.text}</p>
                  {turn.answer?.diagnosis && <div className="assistant-item-actions">
                    <button type="button" className="secondary" onClick={() => { if (turn.answer?.diagnosis) onOpenDiagnostic(turn.answer.diagnosis.destination); }}>
                      {{ "sync-task": "查看同步任务", "media-binding": "检查本机素材", "sync-delivery": "查看工程交付" }[turn.answer.diagnosis.destination]}
                    </button>
                  </div>}
                  {turn.answer && retrievalResults(turn.answer).length ? (
                    <div className="assistant-answer-evidence">
                      <p className="eyebrow">证据引用</p>
                      {retrievalResults(turn.answer).slice(0, 6).map((row, index) => (
                        <button
                          type="button"
                          key={`${row.group_id ?? "doc"}-${index}`}
                          disabled={!canOpenEvidence(row)}
                          onClick={() => onOpenEvidence(row)}
                        >
                          <span className="assistant-evidence-source">{row.source_label || SOURCE_LABELS[row.source ?? ""] || "证据"}</span>
                          <small>{row.snippet || "没有可显示的片段"}</small>
                        </button>
                      ))}
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          )) : (
            <p className="assistant-thread-empty">直接询问镜头依据、台词来源或当前同步进度。Enter 发送，Shift+Enter 换行。</p>
          )}
          <div ref={threadEndRef} />
        </div>

        <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <textarea
            aria-label="给小镜的问题"
            autoFocus
            rows={2}
            value={prompt}
            onChange={(event) => {
              draft.text = event.target.value;
              setPrompt(draft.text);
            }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                void ask();
              }
            }}
            placeholder="这条素材有什么依据？哪个 Take 对白最接近？"
          />
          <button type="submit" disabled={busy || !prompt.trim()}>{busy ? "思考中…" : "发送"}</button>
        </form>
      </div>
      <details className="assistant-project-items">
        <summary>项目事项 <span>{status?.items?.length ?? 0}</span></summary>
        {status?.summary && <p>{status.summary}</p>}
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
            }) : <p className="empty-copy">当前没有待处理事项。</p>}
          </div>
        <button type="button" className="secondary" disabled={busy} onClick={() => void cycle()}>重新检查</button>
      </details>
    </section>
  );
}
