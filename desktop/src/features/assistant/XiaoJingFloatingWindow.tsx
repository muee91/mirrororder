import { isTauri } from "@tauri-apps/api/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { errorMessage } from "../../api/host";
import type { AssistantEvidenceItem } from "../../api/production";
import {
  DEFAULT_XIAOJING_WINDOW_STATE, dispatchXiaoJingAction, hideXiaoJingWindow, listenXiaoJingContextUpdated,
  readXiaoJingContext, readXiaoJingWindowState, setXiaoJingAlwaysOnTop,
  type XiaoJingContextSnapshot, type XiaoJingMainAction, type XiaoJingWindowState,
} from "../../api/xiaojingWindow";
import { StudioIcon, type StudioIconName } from "../../components/StudioIcons";
import { cameraPresentation } from "../media/cameraPresentation";
import { AnswerMarkdown, evidenceTitle } from "./assistantMarkdown";
import {
  assistantAnswerMode, assistantFallbackHint, DIAGNOSTIC_LABELS, diagnosticPage, evidenceHitTime, evidenceSourceLabel,
  itemKindLabel, PROJECT_PROMPTS, SELECTION_CUE, SELECTION_PROMPT,
} from "./assistantPresentation";
import { AssistantSuggestedActionCard } from "./AssistantSuggestedActionCard";
import { useAssistantConversation, useAssistantCopy, useAssistantTextRoute } from "./useAssistantConversation";
import { XiaoJingMonitor } from "./XiaoJingMonitor";
import "./xiaojing-floating.css";

const QUICK_PROMPTS: { question: string; label: string; icon: StudioIconName }[] = [
  { question: PROJECT_PROMPTS[0], label: "项目缺口", icon: "status" },
  { question: PROJECT_PROMPTS[1], label: "找特写", icon: "takes" },
  { question: PROJECT_PROMPTS[2], label: "场记 NG / 部分可用", icon: "slate" },
  { question: SELECTION_PROMPT, label: "问选区", icon: "watch" },
];

function XiaoJingEvidence({ row, active, playing, onOpen }: {
  row: AssistantEvidenceItem;
  active: boolean;
  playing: boolean;
  onOpen: (button: HTMLButtonElement) => void;
}) {
  const { metadata } = row;
  const camera = metadata?.camera ? cameraPresentation(metadata.camera) : undefined;
  const time = evidenceHitTime(row);
  const playable = Boolean(row.clip_id || row.group_id);
  const content = <>
    <span className="xj-evidence-heading">
      <span className="xj-badge xj-badge-source">{evidenceSourceLabel(row)}</span>
      {camera && <span className="xj-camera" data-camera-tone={camera.tone}>{camera.label}</span>}
      {metadata?.shot_type_label && <span className="xj-badge">{metadata.shot_type_label}</span>}
      {metadata?.slate_status === "ng" && <span className="xj-badge xj-badge-ng">NG</span>}
      {metadata?.slate_status === "partial" && <span className="xj-badge xj-badge-partial">部分可用</span>}
      {time && <time>{time}</time>}
    </span>
    <strong>{evidenceTitle(row)}</strong>
    {row.snippet && <span className="xj-evidence-snippet">{row.snippet}</span>}
  </>;
  return <article className="xj-evidence-card" data-camera-tone={camera?.tone} data-active={active || undefined}>
    {playable ? <button type="button" aria-expanded={active} aria-controls={active ? "xj-inline-monitor" : undefined}
      onClick={(event) => onOpen(event.currentTarget)}>
      <span className="xj-evidence-info">{content}</span>
      <span className="xj-evidence-play">
        {playing ? <i aria-label="正在播放" role="img" /> : <StudioIcon name="play" size={15} />}
      </span>
    </button> : <div className="xj-evidence-info">{content}</div>}
  </article>;
}

interface DeskProps {
  snapshot: XiaoJingContextSnapshot | null;
  connecting: boolean;
  windowState: XiaoJingWindowState | null;
  windowMessage: string;
  desktop: boolean;
  mac: boolean;
  pinning: boolean;
  onSelectProject: (projectId: string) => void;
  onTogglePin: () => void;
  onHide: () => void;
}

function XiaoJingDesk({
  snapshot, connecting, windowState, windowMessage, desktop, mac, pinning, onSelectProject, onTogglePin, onHide,
}: DeskProps) {
  const baseUrl = snapshot?.base_url ?? "";
  const projectId = snapshot?.project_id ?? "";
  const projectName = snapshot?.project_name || projectId;
  const selectionSummary = snapshot?.selection_summary ?? "";
  const hasProject = Boolean(baseUrl && projectId);
  const conversation = useAssistantConversation(baseUrl, projectId);
  const textRoute = useAssistantTextRoute(baseUrl, hasProject);
  const { status, items, loading, turns, controlsLocked, command, message, setMessage } = conversation;
  const { copied, copy } = useAssistantCopy<number>(() => setMessage("无法复制，请选中回答文字后手动复制。"));
  const [tab, setTab] = useState<"chat" | "items">("chat");
  const [scopeMode, setScopeMode] = useState<"auto" | "selection">("auto");
  const [prompt, setPrompt] = useState("");
  const [monitor, setMonitor] = useState<{ cardId: string; revision: number; row: AssistantEvidenceItem } | null>(null);
  const [playing, setPlaying] = useState(false);
  const monitorRevision = useRef(0);
  const lastEvidenceButton = useRef<HTMLButtonElement>(null);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const threadEndRef = useRef<HTMLDivElement>(null);
  const prompts = selectionSummary ? QUICK_PROMPTS : QUICK_PROMPTS.slice(0, 3);
  const alwaysOnTop = (windowState ?? DEFAULT_XIAOJING_WINDOW_STATE).always_on_top;
  const priority = (items[0]?.priority ?? 0) >= 80;
  const onlySelection = scopeMode === "selection" && Boolean(selectionSummary);
  const modelLabel = textRoute?.enabled
    ? `${textRoute.local ? "本地模型" : "云端模型"} · ${textRoute.model || "已连接"}`
    : "离线直检";

  function closeMonitor(restoreFocus = true) {
    setMonitor(null);
    setPlaying(false);
    if (restoreFocus) lastEvidenceButton.current?.focus();
  }

  function openMonitor(row: AssistantEvidenceItem, cardId: string, control: HTMLButtonElement) {
    lastEvidenceButton.current = control;
    setPlaying(false);
    setMonitor({ cardId, revision: ++monitorRevision.current, row });
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.repeat) return;
      if (monitor) closeMonitor();
      else if (desktop) onHide();
      else return;
      event.preventDefault();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [desktop, monitor, onHide]);

  useLayoutEffect(() => {
    const field = promptRef.current;
    if (!field) return;
    field.style.height = "0px";
    field.style.height = `${field.scrollHeight}px`;
  }, [prompt, tab]);

  useEffect(() => {
    if (tab === "chat") threadEndRef.current?.scrollIntoView?.({ block: "nearest" });
  }, [tab, turns.length, command]);

  function dispatch(action: XiaoJingMainAction) {
    void dispatchXiaoJingAction(action).catch((error) => {
      setMessage(action.kind === "task_submitted" ? "任务已提交，主窗口状态刷新失败。"
        : `无法打开镜序主窗口：${errorMessage(error)}`);
    });
  }

  function openSettings() { dispatch({ kind: "open_settings" }); }
  function openStatus() { dispatch({ kind: "open_status" }); }
  function focusTake(groupId: string, destination: "material" | "script", clipId?: string) {
    dispatch({ kind: "focus_take", project_id: projectId, group_id: groupId, ...(clipId ? { clip_id: clipId } : {}), destination });
  }

  function ask(text = prompt, wholeProject = false) {
    const question = text.trim();
    if (!question || !snapshot || controlsLocked) return;
    const includeSelection = !wholeProject && (onlySelection || SELECTION_CUE.test(question));
    const inputKind = snapshot.projects.find((project) => project.project_id === projectId)?.input_kind;
    const page = snapshot.current_page || (inputKind === "media-directory" ? "sync-task" : "slate");
    if (!conversation.ask(question, {
      ...(includeSelection ? snapshot.selection : {}),
      project_id: projectId,
      page,
    })) return;
    if (wholeProject) setScopeMode("auto");
    if (question === prompt.trim()) setPrompt("");
    setTab("chat");
  }

  const shortcut = mac ? "⌘J" : "Ctrl+J";
  const globalShortcut = mac ? "⌘⌥J" : "Ctrl+Alt+J";

  return <main className="xj-hud" aria-label="小镜">
    <header className={`xj-header${desktop && mac ? " xj-header-mac" : ""}`} data-tauri-drag-region>
      <div className="xj-header-identity" data-tauri-drag-region>
        <span className="xj-header-mark" data-tauri-drag-region><StudioIcon name="sparkle" size={17} /></span>
        <h1 data-tauri-drag-region>小镜</h1>
        <span className="xj-project-switch" data-tauri-drag-region="false" title={projectName || snapshot?.workspace_name}>
          <select aria-label="切换项目" data-tauri-drag-region="false" value={projectId}
            disabled={!snapshot?.projects.length}
            onChange={(event) => onSelectProject(event.target.value)}>
            {!projectId && <option value="" disabled>选择项目</option>}
            {snapshot?.projects.map((project) => <option key={project.project_id} value={project.project_id}>
              {project.name || project.project_id}
            </option>)}
          </select>
          <StudioIcon name="chevron-down" size={12} />
        </span>
      </div>
      <div className="xj-header-controls" data-tauri-drag-region="false">
        <button type="button" className="xj-icon-button xj-pin" aria-label="置顶" aria-pressed={alwaysOnTop}
          title={alwaysOnTop ? "取消置顶" : "置顶"} disabled={!desktop || pinning || !windowState} onClick={onTogglePin}>
          <StudioIcon name="pin" size={15} />
        </button>
        <button type="button" className="xj-tab-toggle" aria-controls="xj-project-view" disabled={!hasProject}
          aria-label={tab === "chat" ? `项目事项，${items.length} 项${priority ? "，含优先事项" : ""}` : "对话"}
          onClick={() => setTab((current) => current === "chat" ? "items" : "chat")}>
          <span>{tab === "chat" ? <><span className="xj-tab-prefix">项目</span>事项</> : "对话"}</span>
          <span className="xj-item-count" data-priority={priority || undefined}
            aria-label={`${items.length} 个事项${priority ? "，含优先事项" : ""}`}>{items.length}</span>
        </button>
        <button type="button" className="xj-icon-button" aria-label="清空对话" title="清空对话"
          disabled={!turns.length || controlsLocked} onClick={() => { if (conversation.clear()) closeMonitor(false); }}>
          <StudioIcon name="trash" size={15} />
        </button>
        <button type="button" className="xj-icon-button" aria-label="收起窗口" title="收起窗口 · Esc" disabled={!desktop}
          onClick={() => { closeMonitor(false); onHide(); }}>
          <StudioIcon name="minimize" size={17} />
        </button>
      </div>
    </header>

    {monitor && <XiaoJingMonitor key={monitor.revision} baseUrl={baseUrl} projectId={projectId} row={monitor.row}
      onClose={closeMonitor} onPlaying={setPlaying} onFocusTake={focusTake} />}
    {(windowMessage || message) && <p className="xj-feedback" role="status">{windowMessage || message}</p>}

    {!hasProject ? <section className="xj-scroll xj-empty" aria-label="项目状态">
      <div className="xj-prism" aria-hidden="true"><StudioIcon name="sparkle" size={27} /></div>
      <h2>{connecting ? "正在读取项目…" : "打开一个短剧项目"}</h2>
      {!connecting && <p>在镜序打开工作区并选择项目，即可查找素材和项目事项。</p>}
    </section> : tab === "items" ? (
      <section id="xj-project-view" className="xj-scroll xj-items" aria-label="项目事项">
        <header className="xj-items-header">
          <div><h2>项目事项</h2><p>{status?.summary || (loading ? "正在读取项目事项…" : "当前项目的待处理事项")}</p></div>
          <button type="button" disabled={controlsLocked} onClick={() => conversation.cycle()}>
            <StudioIcon name="refresh" size={14} /> 重新检查
          </button>
        </header>
        {items.map((item, index) => {
          const groupId = typeof item.group_id === "string" ? item.group_id : "";
          const actions = Array.isArray(item.actions) ? item.actions : [];
          const detail = typeof item.message === "string" ? item.message : item.summary;
          return <article className="xj-item" key={item.item_id ?? index}>
            <div className="xj-item-type">
              <span>{itemKindLabel(item.kind ?? item.status)}</span>
              {(item.priority ?? 0) >= 80 && <span className="xj-badge xj-badge-partial">优先</span>}
            </div>
            <h3>{item.title ?? "项目事项"}</h3>
            {detail && <p>{detail}</p>}
            {typeof item.context === "string" && item.context && <p>{item.context}</p>}
            {groupId && <div className="xj-actions">
              {actions.includes("focus") && <button type="button" onClick={() => focusTake(groupId, "material")}>定位 Take</button>}
              {actions.includes("placement") && <button type="button" onClick={() => focusTake(groupId, "script")}>去剧本归集</button>}
            </div>}
          </article>;
        })}
        {!loading && status && !items.length && <p className="xj-muted">当前没有待处理事项。</p>}
      </section>
    ) : <>
      <section className="xj-scroll xj-thread" id="xj-project-view" role="log" aria-label="小镜对话">
        {loading ? <p className="xj-muted" role="status">正在读取对话…</p> : !turns.length ? (
          <div className="xj-ready">
            <div className="xj-prism" aria-hidden="true"><StudioIcon name="sparkle" size={28} /></div>
            <h2>《{projectName}》</h2>
            <div className="xj-shortcuts">
              {windowState?.global_shortcut_registered && <><kbd>{globalShortcut}</kbd> 全局随时呼出 <span>·</span> </>}
              <kbd>{shortcut}</kbd> 镜序内呼出
            </div>
            <div className="xj-prompt-list" aria-label="推荐提问">
              {prompts.map(({ question, icon }) => <button key={question} type="button" disabled={controlsLocked} onClick={() => ask(question)}>
                <StudioIcon name={icon} size={16} /><span>{question}</span><StudioIcon name="arrow-up-right" size={13} />
              </button>)}
            </div>
          </div>
        ) : null}
        {turns.map((turn, index) => {
          if (turn.role === "user") return <div key={turn.id} className="xj-user-turn"><p>{turn.text}</p></div>;
          const { answer } = turn;
          const evidence = answer?.retrieval?.results ?? [];
          const mode = assistantAnswerMode(answer?.answer_mode);
          const fallback = mode === "离线直检" ? assistantFallbackHint(answer?.model_info?.fallback_reason) : "";
          const destination = diagnosticPage(answer?.diagnosis?.destination);
          const question = turns[index - 1]?.role === "user" ? turns[index - 1].text : "";
          return <article key={turn.id} className="xj-answer">
            <div className="xj-answer-mark" aria-hidden="true"><StudioIcon name="sparkle" size={15} /></div>
            <div className="xj-answer-body">
              {answer?.context?.label && <p className="xj-answer-context">{answer.context.label}</p>}
              <AnswerMarkdown text={turn.text} />
              <footer className="xj-answer-footer">
                <span>{mode}</span>
                {fallback && <><span>{fallback}</span><button type="button" onClick={openSettings}>去设置检查</button></>}
                <button type="button" className="xj-copy-answer" onClick={() => void copy(turn.id, turn.text)}>
                  {copied === turn.id ? "已复制" : "复制"}
                </button>
              </footer>
              {((answer?.suggested_scope_switch && question) || destination) && <div className="xj-actions">
                {answer?.suggested_scope_switch && question && <button type="button" disabled={controlsLocked} onClick={() => ask(question, true)}>
                  改用「整个项目」重问
                </button>}
                {destination && <button type="button" title={answer?.diagnosis?.summary} onClick={() => dispatch({
                  kind: "open_diagnostic", project_id: projectId, page: destination,
                })}>{DIAGNOSTIC_LABELS[destination]}</button>}
              </div>}
              {evidence.length > 0 && <div className="xj-evidence" aria-label="证据引用">
                {evidence.slice(0, 6).map((row, evidenceIndex) => {
                  const cardId = `${turn.id}-${evidenceIndex}`;
                  return <XiaoJingEvidence key={cardId} row={row} active={monitor?.cardId === cardId}
                    playing={monitor?.cardId === cardId && playing} onOpen={(control) => openMonitor(row, cardId, control)} />;
                })}
              </div>}
              {answer?.suggested_actions?.map((item, i) => <AssistantSuggestedActionCard key={i} item={item}
                baseUrl={baseUrl} projectId={projectId} onOpenSettings={openSettings} onOpenStatus={openStatus}
                onTaskSubmitted={() => dispatch({ kind: "task_submitted", project_id: projectId })} />)}
            </div>
          </article>;
        })}
        {command === "ask" && <p className="xj-thinking" role="status"><i />正在核对项目证据…</p>}
        <div ref={threadEndRef} />
      </section>
      <div className="xj-composer-dock">
        {turns.length > 0 && <div className="xj-quick-prompts" aria-label="快捷提问">
          {prompts.map(({ question, label }) => <button key={question} type="button" disabled={controlsLocked}
            title={question} onClick={() => ask(question)}>{label}</button>)}
        </div>}
        <form className="xj-composer-shell" onSubmit={(event) => { event.preventDefault(); ask(); }}>
          <textarea ref={promptRef} rows={1} aria-label="给小镜的问题" placeholder="询问项目状态或素材证据"
            title="Enter 发送，Shift+Enter 换行" value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
                event.preventDefault();
                ask();
              }
            }} />
          <div className="xj-composer-tools">
            <button type="button" className="xj-scope" aria-pressed={onlySelection}
              disabled={!selectionSummary} title={selectionSummary || "请在主窗口选择素材或剧本段落"}
              onClick={() => setScopeMode((mode) => mode === "auto" ? "selection" : "auto")}>
              {onlySelection ? "仅选区" : "全项目"}
            </button>
            <span className="xj-model" title={modelLabel}>
              <span aria-hidden="true" data-online={textRoute?.enabled || undefined}>{textRoute?.enabled ? "●" : "○"}</span>
              <span>{modelLabel}</span>
            </span>
            <button type="button" className="xj-settings" onClick={openSettings}>设置</button>
            <button type="submit" className="xj-send" aria-label="发送" disabled={controlsLocked || !prompt.trim()}>
              <StudioIcon name="arrow-up" size={18} />
            </button>
          </div>
        </form>
      </div>
    </>}
  </main>;
}

export function XiaoJingFloatingWindow() {
  const desktop = isTauri();
  const mac = /Mac/.test(navigator.platform);
  const [snapshot, setSnapshot] = useState<XiaoJingContextSnapshot | null>(null);
  const [connecting, setConnecting] = useState(true);
  const [windowState, setWindowState] = useState<XiaoJingWindowState | null>(null);
  const [message, setMessage] = useState("");
  const [pinning, setPinning] = useState(false);
  const [requestedProject, setRequestedProject] = useState<{ workspaceId: string; projectId: string } | null>(null);

  useEffect(() => {
    let active = true;
    let receivedContext = false;
    let stop: (() => void) | undefined;
    void listenXiaoJingContextUpdated((next) => {
      if (!active) return;
      receivedContext = true;
      setSnapshot(next);
      setConnecting(false);
    }).then((unlisten) => {
      if (active) stop = unlisten;
      else unlisten();
    }).catch((error) => { if (active) setMessage(`无法监听镜序项目：${errorMessage(error)}`); }).then(async () => {
      if (!active) return;
      const initial = await readXiaoJingContext();
      if (active && !receivedContext) setSnapshot(initial);
    }).catch((error) => { if (active) setMessage(`无法读取镜序项目：${errorMessage(error)}`); }).finally(() => {
      if (active) setConnecting(false);
    });
    void readXiaoJingWindowState().then((state) => {
      if (active) setWindowState(state);
    }).catch((error) => { if (active) setMessage(`无法读取小镜窗口：${errorMessage(error)}`); });
    return () => { active = false; stop?.(); };
  }, []);

  useEffect(() => {
    if (!requestedProject) return;
    if (snapshot?.workspace_id !== requestedProject.workspaceId || snapshot?.project_id === requestedProject.projectId
      || !snapshot?.projects.some((project) => project.project_id === requestedProject.projectId)) {
      setRequestedProject(null);
    }
  }, [requestedProject, snapshot]);

  function selectProject(projectId: string) {
    if (!snapshot?.projects.some((project) => project.project_id === projectId)) return;
    const requested = { workspaceId: snapshot.workspace_id, projectId };
    setRequestedProject(requested);
    setMessage("");
    void dispatchXiaoJingAction({ kind: "select_project", project_id: projectId }).catch((error) => {
      setRequestedProject((current) => current === requested ? null : current);
      setMessage(`无法切换镜序项目：${errorMessage(error)}`);
    });
  }

  async function pin() {
    if (!windowState || pinning) return;
    setPinning(true);
    setMessage("");
    try {
      setWindowState(await setXiaoJingAlwaysOnTop(!windowState.always_on_top));
    } catch (error) {
      setMessage(`无法切换置顶：${errorMessage(error)}`);
    } finally {
      setPinning(false);
    }
  }

  const hide = useCallback(() => {
    void hideXiaoJingWindow().catch((error) => setMessage(`无法收起小镜：${errorMessage(error)}`));
  }, []);

  const requested = snapshot && requestedProject?.workspaceId === snapshot.workspace_id
    ? snapshot.projects.find((project) => project.project_id === requestedProject.projectId)
    : undefined;
  const context = snapshot && requested && requested.project_id !== snapshot.project_id ? {
    ...snapshot, project_id: requested.project_id, project_name: requested.name,
    current_page: "", selection: {}, selection_summary: "",
  } : snapshot;

  return <XiaoJingDesk key={JSON.stringify([context?.base_url, context?.workspace_id, context?.project_id])}
    snapshot={context} connecting={connecting} desktop={desktop} mac={mac}
    windowState={windowState} windowMessage={message} pinning={pinning}
    onSelectProject={selectProject} onTogglePin={() => void pin()} onHide={hide} />;
}
