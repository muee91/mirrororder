import { useEffect, useMemo, useState } from "react";
import { HostConnectionError } from "../../api/host";
import { ProductionClient, type AssistantAnswer, type AssistantStatus } from "../../api/production";
import { AssistantModelsPanel } from "./AssistantModelsPanel";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function answerText(answer: AssistantAnswer | null): string {
  if (!answer) return "";
  return String(answer.answer ?? answer.message ?? answer.text ?? "");
}

export function AssistantWorkbench({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [prompt, setPrompt] = useState("");
  const [answer, setAnswer] = useState<AssistantAnswer | null>(null);
  const [message, setMessage] = useState("正在读取小镜状态…");
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    setMessage("正在读取小镜状态…");
    try {
      const next = await client.assistant(projectId);
      setStatus(next);
      setMessage(`assistant.v1 · r${next.revision}`);
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
    setMessage("正在让小镜重新检查项目…");
    try {
      const next = await client.cycleAssistant(projectId, true);
      setStatus(next);
      setMessage(`小镜已刷新 · r${next.revision}`);
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
      setMessage("回答完成；建议仍需人工确认后才能影响生产 authority。");
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
          <p className="eyebrow">Phase 3 · Assistant</p>
          <h2>小镜</h2>
        </div>
        <div className="assistant-heading-actions">
          <span className="production-state">{message}</span>
          <button type="button" className="secondary" disabled={busy} onClick={() => void cycle()}>重新检查项目</button>
        </div>
      </header>

      <div className="production-grid assistant-grid">
        <div className="production-panel">
          <p className="eyebrow">项目关注队列</p>
          <h3>{status?.summary || "当前没有摘要"}</h3>
          <div className="assistant-items">
            {(status?.items ?? []).length ? (status?.items ?? []).slice(0, 18).map((item, index) => (
              <article className="assistant-item" key={String(item.item_id ?? `${item.kind ?? "item"}-${index}`)}>
                <div>
                  <span>{String(item.kind ?? item.status ?? "attention")}</span>
                  <strong>{String(item.title ?? item.summary ?? "项目事项")}</strong>
                </div>
                <em>P{Number(item.priority ?? 0)}</em>
                {item.title && item.summary ? <p>{String(item.summary)}</p> : null}
              </article>
            )) : <p className="empty-copy">当前没有需要小镜突出显示的事项。</p>}
          </div>
        </div>

        <aside className="production-panel assistant-chat">
          <p className="eyebrow">项目对话</p>
          <textarea rows={5} value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：哪些场还缺明确 Best？场记 NG 与当前选择有没有冲突？" />
          <button type="button" disabled={busy || !prompt.trim()} onClick={() => void ask()}>询问小镜</button>
          {answer ? <div className="assistant-answer">{answerText(answer) || JSON.stringify(answer, null, 2)}</div> : null}
          <p className="production-note">小镜可以分析、规划、提交 proposal，但这个页面没有直接 review / Editorial Decision / FCPXML 写权限。</p>
        </aside>
      </div>

      <AssistantModelsPanel baseUrl={baseUrl} projectId={projectId} />
    </section>
  );
}
