import { useEffect, useId, useMemo, useRef, useState } from "react";
import { errorMessage } from "../../api/host";
import { MODEL_ROUTING_CHANGED_EVENT, ModelSettingsClient, type EffectiveModelRouting } from "../../api/models";
import {
  ProductionClient, type AssistantAnswer, type AssistantDiagnosis, type AssistantEvidenceItem,
  type AssistantQuestionContext, type AssistantStatus, type AssistantSuggestedAction,
} from "../../api/production";
import { ProjectTaskClient } from "../../api/tasks";
import { StudioIcon } from "../../components/StudioIcons";
import { canOpenEvidence, type EvidenceReference } from "../production/evidenceLocation";

interface Props {
  baseUrl: string;
  projectId: string;
  active?: boolean;
  currentPage?: string;
  selectionSummary?: string;
  draft: { text: string; includeSelection: boolean };
  readContext: (includeSelection: boolean) => AssistantQuestionContext;
  onOpenEvidence: (reference: EvidenceReference) => void;
  onOpenDiagnostic: (page: AssistantDiagnosis["destination"]) => void;
  onFocusTake?: (groupId: string, destination?: "material" | "script" | "review", clipId?: string) => void;
  onOpenSettings?: () => void;
  onOpenStatus?: () => void;
  onTaskSubmitted?: () => void;
}

const SOURCE_LABELS: Record<string, string> = {
  visual: "画面",
  speech: "对白",
  slate: "场记",
  file: "文件名",
  script: "剧本",
};

const DIAGNOSTIC_LABELS = {
  "sync-task": "查看同步任务",
  "media-binding": "检查本机素材",
  "sync-delivery": "查看工程交付",
};

const FALLBACK_HINTS: Record<string, string> = {
  http_401: "模型连接认证失败",
  http_403: "模型连接权限不足",
  timeout: "模型响应超时",
  local_model_not_downloaded: "本地模型尚未下载",
  local_server_unavailable: "本地模型服务暂不可用",
  network_error: "模型连接中断",
  invalid_json: "模型回答格式不受支持",
  invalid_response: "模型回应无法读取",
  empty_response: "模型未返回回答",
};

const SELECTION_CUE = /(这条|这组|当前镜头|当前片段|这个片段|这镜|当前\s*take|查这条|查这组|这一条|这一组)/i;
const SYNC_PAGES = new Set(["sync-task", "sync-inspect", "sync-delivery"]);
const CLOSE_UP_PROMPT = "帮我找特写片段";
const SYNC_PROMPTS = ["现在能交付吗？卡在哪？", "总结当前同步与素材状态", CLOSE_UP_PROMPT];
const PROJECT_PROMPTS = ["项目现在还有哪些缺口和待处理？", CLOSE_UP_PROMPT, "列出场记标了 NG 或部分可用的镜头"];
const TABS = ["chat", "items"] as const;
type Tab = (typeof TABS)[number];

type AssistantTurn = {
  id: number;
  role: "user" | "assistant";
  text: string;
  answer?: AssistantAnswer;
  evidence?: AssistantEvidenceItem[];
};

function inlineMarkdown(text: string) {
  return text.split(/(`[^`\n]+`|\*\*[^*\n]+\*\*)/g).map((part, index) => {
    if (index % 2 === 0) return part;
    if (part.startsWith("`")) return <code key={index}>{part.slice(1, -1)}</code>;
    return <strong key={index}>{inlineMarkdown(part.slice(2, -2))}</strong>;
  });
}

function AnswerMarkdown({ text }: { text: string }) {
  const blocks: { kind: "paragraph" | "ul" | "ol"; lines: string[]; start?: number }[] = [];
  let block: (typeof blocks)[number] | undefined;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      block = undefined;
      continue;
    }
    const bullet = /^\s*[-+*]\s+(.+)$/.exec(line);
    const numbered = /^\s*(\d+)[.)]\s+(.+)$/.exec(line);
    const kind = bullet ? "ul" : numbered ? "ol" : "paragraph";
    if (!block || block.kind !== kind) {
      block = { kind, lines: [], start: numbered ? Number(numbered[1]) : undefined };
      blocks.push(block);
    }
    block.lines.push(bullet?.[1] ?? numbered?.[2] ?? line);
  }
  return <div className="assistant-markdown">{blocks.map(({ kind, lines, start }, index) => {
    if (kind === "paragraph") return <p key={index}>{inlineMarkdown(lines.join("\n"))}</p>;
    const List = kind;
    return <List key={index} start={start}>{lines.map((line, i) => <li key={i}>{inlineMarkdown(line)}</li>)}</List>;
  })}</div>;
}

function formatEvidenceTime(seconds: number) {
  const tenths = Math.round(Math.max(0, seconds) * 10);
  const minutes = String(Math.floor(tenths / 600)).padStart(2, "0");
  const withinMinute = (tenths % 600 / 10).toFixed(1).padStart(4, "0");
  return `${minutes}:${withinMinute}`;
}

function EvidenceCard({ row, onOpenEvidence, onFocusTake }: {
  row: AssistantEvidenceItem;
} & Pick<Props, "onOpenEvidence" | "onFocusTake">) {
  const { group_id: groupId, clip_id: clipId, metadata, source } = row;
  const canPlay = canOpenEvidence(row);
  const start = Number.isFinite(row.start) ? row.start! : 0;
  const end = Number.isFinite(row.end) ? row.end! : start;
  const time = end > start ? `${formatEvidenceTime(start)} – ${formatEvidenceTime(end)}`
    : source === "speech" ? formatEvidenceTime(start) : null;
  const title = metadata?.take_label || metadata?.file_name || (groupId ? `Take ${groupId}` : "独立证据");
  const body = <>
    <span className="assistant-evidence-badges">
      <span className="assistant-evidence-source">{row.source_label || SOURCE_LABELS[source ?? ""] || "证据"}</span>
      {metadata?.camera && <span>{metadata.camera.endsWith("机") ? metadata.camera : `${metadata.camera}机`}</span>}
      {metadata?.shot_type_label && <span>{metadata.shot_type_label}</span>}
      {metadata?.slate_status === "ng" && <span className="is-ng">NG</span>}
      {metadata?.slate_status === "partial" && <span className="is-partial">部分可用</span>}
      {time && <span className="assistant-evidence-time">{time}</span>}
    </span>
    <strong>{title}</strong>
    {row.snippet && <small>{row.snippet}</small>}
  </>;
  return <article className="assistant-evidence-card">
    {canPlay ? <button type="button" className="assistant-evidence-body" onClick={() => onOpenEvidence(row)}>
      {body}
      <span className="assistant-evidence-play"><StudioIcon name="watch" size={12} /> 播放证据</span>
    </button> : <div className="assistant-evidence-body">{body}</div>}
    {groupId && onFocusTake && <div className="assistant-item-actions">
      <button type="button" className="secondary" onClick={() => onFocusTake(groupId, "material", clipId)}>定位 Take</button>
    </div>}
  </article>;
}

function SuggestedActionCard({ item, baseUrl, projectId, onOpenSettings, onOpenStatus, onTaskSubmitted }: {
  item: AssistantSuggestedAction;
} & Pick<Props, "baseUrl" | "projectId" | "onOpenSettings" | "onOpenStatus" | "onTaskSubmitted">) {
  const [state, setState] = useState<"ready" | "pending" | "submitted">("ready");
  const [error, setError] = useState("");
  const taskType = item.task_type;
  const isTask = item.action === "submit_task";
  const open = item.action === "open_settings" ? onOpenSettings : item.action === "open_status" ? onOpenStatus : undefined;

  async function submit() {
    if (!taskType || state !== "ready") return;
    setState("pending");
    setError("");
    try {
      await new ProjectTaskClient(baseUrl).submit(projectId, { type: taskType, targets: item.targets, actor: "desktop" });
    } catch (reason) {
      setError(errorMessage(reason));
      setState("ready");
      return;
    }
    setState("submitted");
    onTaskSubmitted?.();
  }

  return <article className="assistant-action-card">
    <strong>{item.label}</strong>
    {item.description && <p>{item.description}</p>}
    <div className="assistant-item-actions">
      {isTask && state === "submitted" ? <>
        <span className="assistant-task-confirmation" role="status">已提交后台任务</span>
        {onOpenStatus && <button type="button" className="secondary" onClick={onOpenStatus}>查看状态中心</button>}
      </> : isTask ? (
        <button type="button" className="secondary" disabled={!taskType || state === "pending"} onClick={() => void submit()}>
          {state === "pending" ? "正在提交…" : "提交后台任务"}
        </button>
      ) : open && (
        <button type="button" className="secondary" onClick={open}>{item.action === "open_settings" ? "打开设置" : "查看状态中心"}</button>
      )}
    </div>
    {error && <p role="alert">{error}</p>}
  </article>;
}

function itemKindLabel(value: string | undefined) {
  return {
    decision: "需要判断",
    production: "制作提醒",
    people: "人物线索",
    attention: "需要留意",
  }[value ?? ""] ?? "项目事项";
}

export function AssistantWorkbench({
  baseUrl, projectId, active = true, currentPage = "", selectionSummary = "", draft, readContext,
  onOpenDiagnostic, onOpenEvidence, onFocusTake, onOpenSettings, onOpenStatus, onTaskSubmitted,
}: Props) {
  const client = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const tabsId = useId();
  const [tab, setTab] = useState<Tab>("chat");
  const [scopeMode, setScopeMode] = useState<"auto" | "selection">("auto");
  const [routing, setRouting] = useState<EffectiveModelRouting | null>(null);
  const [status, setStatus] = useState<AssistantStatus | null>(null);
  const [prompt, setPrompt] = useState(draft.text);
  const [turns, setTurns] = useState<AssistantTurn[]>([]);
  const [loading, setLoading] = useState(true);
  const [command, setCommand] = useState<"ask" | "cycle" | "clear" | null>(null);
  const [message, setMessage] = useState("");
  const [copiedId, setCopiedId] = useState<number | null>(null);
  const copyTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const nextTurnId = useRef(0);
  const busy = command === "ask";
  const controlsLocked = loading || command !== null;
  const hasSelection = Boolean(selectionSummary);
  const prompts = SYNC_PAGES.has(currentPage) ? SYNC_PROMPTS : PROJECT_PROMPTS;
  const quickPrompts = hasSelection ? [...prompts, "这条素材的依据和问题是什么？"] : prompts;
  const items = useMemo(() => [...(status?.items ?? [])].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0)), [status]);
  const textRoute = routing?.text;

  useEffect(() => {
    let current = true;
    setLoading(true);
    void client.assistant(projectId).then((next) => {
      if (!current) return;
      setStatus(next);
      setTurns((next.messages ?? []).map((item) => ({
        id: nextTurnId.current++,
        role: item.role === "user" ? "user" : "assistant",
        text: item.text,
        evidence: item.evidence,
        answer: item.role === "assistant" ? {
          context: item.context,
          diagnosis: item.diagnosis,
          answer_mode: item.answer_mode,
          suggested_actions: item.suggested_actions,
        } : undefined,
      })));
    }).catch((error) => { if (current) setMessage(errorMessage(error)); }).finally(() => {
      if (current) setLoading(false);
    });
    return () => { current = false; };
  }, [client, projectId]);

  useEffect(() => {
    if (!active) return;
    let request = 0;
    async function refreshRouting() {
      const latest = ++request;
      try {
        const payload = await new ModelSettingsClient(baseUrl).read();
        if (latest === request) setRouting(payload.routing ?? null);
      } catch {
        if (latest === request) setRouting(null);
      }
    }
    void refreshRouting();
    window.addEventListener(MODEL_ROUTING_CHANGED_EVENT, refreshRouting);
    return () => {
      request++;
      window.removeEventListener(MODEL_ROUTING_CHANGED_EVENT, refreshRouting);
    };
  }, [active, baseUrl]);

  useEffect(() => {
    if (active && !promptRef.current?.closest("[hidden]")) promptRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (active && tab === "chat") threadEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, tab, turns.length, busy]);

  useEffect(() => () => clearTimeout(copyTimer.current), []);

  async function cycle() {
    if (controlsLocked) return;
    setCommand("cycle");
    setMessage("正在重新检查当前项目…");
    try {
      const next = await client.cycleAssistant(projectId, true);
      setStatus(next);
      setMessage(`已检查 · ${next.items?.length ?? 0} 个项目事项`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setCommand(null);
    }
  }

  async function clearConversation() {
    if (controlsLocked || !turns.length) return;
    setCommand("clear");
    setMessage("");
    try {
      setStatus(await client.clearAssistant(projectId));
      setTurns([]);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setCommand(null);
    }
  }

  async function ask(text = prompt, wholeProject = false) {
    const question = text.trim();
    if (!question || controlsLocked) return;
    if (wholeProject) setScopeMode("auto");
    const context = readContext(!wholeProject && (scopeMode === "selection" || SELECTION_CUE.test(question)));
    const userTurn: AssistantTurn = { id: nextTurnId.current++, role: "user", text: question };
    setTurns((current) => [...current, userTurn]);
    if (question === prompt.trim()) {
      draft.text = "";
      setPrompt("");
    }
    setTab("chat");
    setCommand("ask");
    setMessage("");
    try {
      const answer = await client.messageAssistant(projectId, question, context);
      const reply: AssistantTurn = {
        id: nextTurnId.current++,
        role: "assistant",
        text: (answer.answer ?? answer.message ?? answer.text) || "小镜未返回可阅读的回答。",
        answer,
      };
      setTurns((current) => [...current, reply]);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setCommand(null);
    }
  }

  async function copyAnswer(turn: AssistantTurn) {
    try {
      await navigator.clipboard.writeText(turn.text);
      setCopiedId(turn.id);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopiedId(null), 1800);
    } catch {
      setMessage("无法复制，请选中回答文字后手动复制。");
    }
  }

  return (
    <section className="assistant-workbench">
      <div className="assistant-tabs" role="tablist" aria-label="小镜工作区">
        {TABS.map((target) => <button
          key={target}
          type="button"
          role="tab"
          id={`${tabsId}-${target}-tab`}
          aria-controls={`${tabsId}-${target}`}
          aria-selected={target === tab}
          tabIndex={target === tab ? 0 : -1}
          onClick={() => setTab(target)}
          onKeyDown={(event) => {
            if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? "chat" : event.key === "End" ? "items" : target === "chat" ? "items" : "chat";
            setTab(next);
            document.getElementById(`${tabsId}-${next}-tab`)?.focus();
          }}
        >
          {target === "chat" ? "对话" : <>项目事项 <span className={`assistant-items-count${(items[0]?.priority ?? 0) >= 80 ? " has-high" : ""}`}
            aria-label={`${items.length} 个事项${(items[0]?.priority ?? 0) >= 80 ? "，含优先事项" : ""}`}>{items.length}</span></>}
        </button>)}
      </div>
      {message && <p className="assistant-feedback" role="status">{message}</p>}

      <div className="assistant-chat" role="tabpanel" id={`${tabsId}-chat`} aria-labelledby={`${tabsId}-chat-tab`} hidden={tab !== "chat"}>
        <div className="assistant-chat-header">
          <button type="button" className="secondary assistant-scope-field" aria-pressed={scopeMode === "selection"}
            title={selectionSummary || "当前没有选区"}
            onClick={() => setScopeMode((mode) => mode === "auto" ? "selection" : "auto")}>
            {scopeMode === "selection" ? "仅当前选区" : "全项目"}
          </button>
          <div className="assistant-route-status">
            <span className="assistant-model-pill" title={textRoute?.enabled ? textRoute.model : undefined}>
              <span aria-hidden="true" className={textRoute?.enabled ? "is-online" : ""}>{textRoute?.enabled ? "●" : "○"}</span>
              {textRoute?.enabled ? `${textRoute.local ? "本地模型" : "云端模型"} · ${textRoute.model || "已连接"}` : "离线直检模式"}
            </span>
            {!textRoute?.enabled && onOpenSettings && <button type="button" className="secondary assistant-text-button" onClick={onOpenSettings}>配置模型</button>}
          </div>
          <button type="button" className="secondary assistant-text-button" disabled={!turns.length || controlsLocked}
            onClick={() => void clearConversation()}>{command === "clear" ? "正在清空…" : "清空对话"}</button>
        </div>
        {(hasSelection || scopeMode === "selection") && <p className="assistant-selection-summary" title={selectionSummary}>
          {scopeMode === "auto" ? "选区参考" : "当前选区"} · {selectionSummary || "尚未选中素材或剧本段落"}
        </p>}

        <div className="assistant-thread" aria-live="polite">
          {turns.map((turn, index) => {
            if (turn.role === "user") return <div key={turn.id} className="assistant-turn is-user">
              <div className="assistant-user-bubble">{turn.text}</div>
            </div>;

            const { answer } = turn;
            const evidenceList = answer?.retrieval?.results ?? turn.evidence ?? [];
            const reason = answer?.model_info?.fallback_reason ?? "";
            const fallbackHint = FALLBACK_HINTS[reason] ?? (/^http_\d{3}$/.test(reason) ? "模型服务暂不可用" : "");
            const mode = answer?.answer_mode === "diagnosis" ? "同步诊断" : answer?.answer_mode === "llm" ? "AI 管家" : "离线直检";
            const diagnosis = answer?.diagnosis;
            const question = turns[index - 1]?.role === "user" ? turns[index - 1].text : "";
            return <div key={turn.id} className="assistant-turn is-assistant">
              <div className="assistant-answer">
                {answer?.context?.label && <strong className="assistant-context-label">{answer.context.label}</strong>}
                <AnswerMarkdown text={turn.text} />
                <div className="assistant-answer-footer">
                  <span className="assistant-mode-badge">{mode}</span>
                  {mode === "离线直检" && fallbackHint && <>
                    <span>{fallbackHint}</span>
                    {onOpenSettings && <button type="button" className="secondary assistant-text-button" onClick={onOpenSettings}>检查设置</button>}
                  </>}
                  <button type="button" className="secondary assistant-text-button assistant-copy"
                    onClick={() => void copyAnswer(turn)}>{copiedId === turn.id ? "已复制" : "复制"}</button>
                </div>
              </div>
              {answer?.suggested_scope_switch && question && <div className="assistant-item-actions">
                <button type="button" className="secondary" disabled={controlsLocked}
                  onClick={() => void ask(question, true)}>改用「整个项目」重问</button>
              </div>}
              {diagnosis && DIAGNOSTIC_LABELS[diagnosis.destination] && <div className="assistant-item-actions">
                <button type="button" className="secondary" title={diagnosis.summary} onClick={() => onOpenDiagnostic(diagnosis.destination)}>
                  {DIAGNOSTIC_LABELS[diagnosis.destination]}
                </button>
              </div>}
              {evidenceList.length > 0 && <div className="assistant-answer-evidence" aria-label="证据引用">
                {evidenceList.slice(0, 6).map((row, i) => <EvidenceCard key={`${row.document_id ?? "evidence"}-${i}`}
                  row={row} onOpenEvidence={onOpenEvidence} onFocusTake={onFocusTake} />)}
              </div>}
              {answer?.suggested_actions?.map((item, i) => <SuggestedActionCard key={i}
                item={item} baseUrl={baseUrl} projectId={projectId} onOpenSettings={onOpenSettings}
                onOpenStatus={onOpenStatus} onTaskSubmitted={onTaskSubmitted} />)}
            </div>;
          })}
          {loading ? <p className="assistant-thread-empty">正在读取对话…</p> : !turns.length && (
            <p className="assistant-thread-empty">可以问项目进度、实际对白或镜头景别。</p>
          )}
          {busy && <div className="assistant-thinking" role="status">
            <span aria-hidden="true"><i /><i /><i /></span> 正在核对项目证据
          </div>}
          <div ref={threadEndRef} />
        </div>

        <div className="assistant-quick-prompts" aria-label="快捷提问">
          {quickPrompts.map((question) => <button key={question} type="button" className="secondary" disabled={controlsLocked}
            onClick={() => void ask(question)}>{question}</button>)}
        </div>
        <form className="assistant-composer" onSubmit={(event) => { event.preventDefault(); void ask(); }}>
          <textarea
            ref={promptRef}
            aria-label="给小镜的问题"
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
            placeholder="询问项目状态或素材证据"
            title="Enter 发送，Shift+Enter 换行"
          />
          <button type="submit" disabled={controlsLocked || !prompt.trim()}>{busy ? "思考中…" : "发送"}</button>
        </form>
      </div>

      <div className="assistant-project-items" role="tabpanel" id={`${tabsId}-items`} aria-labelledby={`${tabsId}-items-tab`} hidden={tab !== "items"}>
        <div className="assistant-items-summary">
          <p>{status?.summary || (loading ? "正在读取项目事项…" : "项目事项来自当前已记录的项目证据。")}</p>
          <button type="button" className="secondary" disabled={controlsLocked} onClick={() => void cycle()}>重新检查</button>
        </div>
        <div className="assistant-items">
          {items.map((item, index) => {
            const groupId = typeof item.group_id === "string" ? item.group_id : "";
            const actions = Array.isArray(item.actions) ? item.actions : [];
            return (
              <article className="assistant-item" key={item.item_id ?? `${item.kind ?? "item"}-${index}`}>
                <div>
                  <span>{itemKindLabel(item.kind ?? item.status)}</span>
                  <strong>{item.title ?? "项目事项"}</strong>
                </div>
                {(item.priority ?? 0) >= 80 && <em>优先</em>}
                {typeof item.message === "string" && item.message && <p className="assistant-item-message">{item.message}</p>}
                {typeof item.context === "string" && item.context && <p className="assistant-item-context">{item.context}</p>}
                {groupId && onFocusTake && actions.length > 0 && <div className="assistant-item-actions">
                  {actions.includes("focus") && <button type="button" className="secondary" onClick={() => onFocusTake(groupId, "material")}>定位 Take</button>}
                  {actions.includes("placement") && <button type="button" className="secondary" onClick={() => onFocusTake(groupId, "script")}>去剧本归集</button>}
                </div>}
              </article>
            );
          })}
          {!loading && status && !items.length && <p className="empty-copy">当前没有待处理事项。</p>}
        </div>
      </div>
    </section>
  );
}
