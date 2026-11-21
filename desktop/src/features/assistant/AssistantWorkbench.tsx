import { useEffect, useId, useRef, useState } from "react";
import type { AssistantDiagnosis, AssistantEvidenceItem, AssistantQuestionContext } from "../../api/production";
import { StudioIcon } from "../../components/StudioIcons";
import { canOpenEvidence, type EvidenceReference } from "../production/evidenceLocation";
import { AnswerMarkdown, evidenceTitle } from "./assistantMarkdown";
import {
  assistantAnswerMode, assistantFallbackHint, DIAGNOSTIC_LABELS, diagnosticPage, evidenceHitTime,
  evidenceSourceLabel, itemKindLabel, PROJECT_PROMPTS, SELECTION_CUE, SELECTION_PROMPT,
} from "./assistantPresentation";
import { AssistantSuggestedActionCard } from "./AssistantSuggestedActionCard";
import { useAssistantConversation, useAssistantCopy, useAssistantTextRoute } from "./useAssistantConversation";

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

const SYNC_PAGES = new Set(["sync-task", "sync-inspect", "sync-delivery"]);
const SYNC_PROMPTS = ["现在能交付吗？卡在哪？", "总结当前同步与素材状态", PROJECT_PROMPTS[1]];
const TABS = ["chat", "items"] as const;
type Tab = (typeof TABS)[number];

function EvidenceCard({ row, onOpenEvidence, onFocusTake }: {
  row: AssistantEvidenceItem;
} & Pick<Props, "onOpenEvidence" | "onFocusTake">) {
  const { group_id: groupId, clip_id: clipId, metadata } = row;
  const canPlay = canOpenEvidence(row);
  const time = evidenceHitTime(row);
  const title = evidenceTitle(row);
  const body = <>
    <span className="assistant-evidence-badges">
      <span className="assistant-evidence-source">{evidenceSourceLabel(row)}</span>
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

export function AssistantWorkbench({
  baseUrl, projectId, active = true, currentPage = "", selectionSummary = "", draft, readContext,
  onOpenDiagnostic, onOpenEvidence, onFocusTake, onOpenSettings, onOpenStatus, onTaskSubmitted,
}: Props) {
  const conversation = useAssistantConversation(baseUrl, projectId);
  const { status, items, turns, loading, command, controlsLocked, message, setMessage } = conversation;
  const textRoute = useAssistantTextRoute(baseUrl, active);
  const { copied: copiedId, copy } = useAssistantCopy<number>(() => setMessage("无法复制，请选中回答文字后手动复制。"));
  const tabsId = useId();
  const [tab, setTab] = useState<Tab>("chat");
  const [scopeMode, setScopeMode] = useState<"auto" | "selection">("auto");
  const [prompt, setPrompt] = useState(draft.text);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const busy = command === "ask";
  const hasSelection = Boolean(selectionSummary);
  const prompts = SYNC_PAGES.has(currentPage) ? SYNC_PROMPTS : PROJECT_PROMPTS;
  const quickPrompts = hasSelection ? [...prompts, SELECTION_PROMPT] : prompts;

  useEffect(() => {
    if (active && !promptRef.current?.closest("[hidden]")) promptRef.current?.focus();
  }, [active]);

  useEffect(() => {
    if (active && tab === "chat") threadEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [active, tab, turns.length, busy]);

  function ask(text = prompt, wholeProject = false) {
    const question = text.trim();
    if (!question || controlsLocked) return;
    const includeSelection = !wholeProject && (scopeMode === "selection" || SELECTION_CUE.test(question));
    if (!conversation.ask(question, readContext(includeSelection))) return;
    if (wholeProject) setScopeMode("auto");
    if (question === prompt.trim()) {
      draft.text = "";
      setPrompt("");
    }
    setTab("chat");
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
            onClick={() => conversation.clear()}>{command === "clear" ? "正在清空…" : "清空对话"}</button>
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
            const evidenceList = answer?.retrieval?.results ?? [];
            const fallbackHint = assistantFallbackHint(answer?.model_info?.fallback_reason);
            const mode = assistantAnswerMode(answer?.answer_mode);
            const diagnosis = answer?.diagnosis;
            const destination = diagnosticPage(diagnosis?.destination);
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
                    onClick={() => void copy(turn.id, turn.text)}>{copiedId === turn.id ? "已复制" : "复制"}</button>
                </div>
              </div>
              {answer?.suggested_scope_switch && question && <div className="assistant-item-actions">
                <button type="button" className="secondary" disabled={controlsLocked}
                  onClick={() => void ask(question, true)}>改用「整个项目」重问</button>
              </div>}
              {destination && <div className="assistant-item-actions">
                <button type="button" className="secondary" title={diagnosis?.summary} onClick={() => onOpenDiagnostic(destination)}>
                  {DIAGNOSTIC_LABELS[destination]}
                </button>
              </div>}
              {evidenceList.length > 0 && <div className="assistant-answer-evidence" aria-label="证据引用">
                {evidenceList.slice(0, 6).map((row, i) => <EvidenceCard key={`${row.document_id ?? "evidence"}-${i}`}
                  row={row} onOpenEvidence={onOpenEvidence} onFocusTake={onFocusTake} />)}
              </div>}
              {answer?.suggested_actions?.map((item, i) => <AssistantSuggestedActionCard key={i}
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
          <button type="button" className="secondary" disabled={controlsLocked} onClick={() => conversation.cycle()}>重新检查</button>
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
