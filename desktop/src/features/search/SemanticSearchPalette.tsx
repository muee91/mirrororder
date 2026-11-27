import { useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { errorMessage } from "../../api/host";
import { SemanticSearchClient, type SemanticSearchPayload, type SemanticSearchResult } from "../../api/semantic";
import { canOpenEvidence } from "../production/evidenceLocation";
import { StudioIcon } from "../../components/StudioIcons";
import "./semantic-search.css";

interface Props {
  baseUrl: string;
  active?: boolean;
  projectId: string;
  onOpenEvidence: (result: SemanticSearchResult) => void;
}

type SourceFilter = "all" | "visual" | "speech" | "slate";

const SOURCE_LABELS: Record<string, string> = {
  visual: "画面",
  speech: "对白",
  slate: "场记",
  file: "文件名",
};
const SEARCH_HINT = "输入原片文件名，或搜索已整理的对白、场记和画面。";

export function SemanticSearchPalette({ baseUrl, projectId, active = true, onOpenEvidence }: Props) {
  const client = useMemo(() => new SemanticSearchClient(baseUrl), [baseUrl]);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [payload, setPayload] = useState<SemanticSearchPayload | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [copiedId, setCopiedId] = useState("");
  const [message, setMessage] = useState(SEARCH_HINT);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const pending = useRef<AbortController | null>(null);
  const submittedQuery = useRef("");

  const results = payload?.results ?? [];
  const activeResult = results[Math.min(selectedIndex, Math.max(0, results.length - 1))] ?? null;

  useEffect(() => {
    if (!active) return;
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if (event.isComposing) return;
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        inputRef.current?.focus();
      }
    }
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, [active]);

  useLayoutEffect(() => {
    if (active && open) inputRef.current?.focus();
  }, [active, open]);

  function clearResults(): void {
    pending.current?.abort();
    pending.current = null;
    submittedQuery.current = "";
    setPayload(null);
    setBusy(false);
    setFailed(false);
    setCopiedId("");
    setMessage(SEARCH_HINT);
  }

  useEffect(() => {
    clearResults();
    return () => pending.current?.abort();
  }, [client, projectId]);

  function show(): void {
    setOpen(true);
    inputRef.current?.focus();
  }

  async function search(semantic = false, filter = source): Promise<void> {
    const text = query.trim();
    if (!text) return;
    pending.current?.abort();
    const request = new AbortController();
    pending.current = request;
    submittedQuery.current = text;
    setBusy(true);
    setFailed(false);
    setPayload(null);
    setMessage("正在查找项目素材…");
    try {
      const options = {
        limit: 20,
        sources: filter === "all" ? undefined : [filter],
        signal: request.signal,
      };
      const next = await (semantic ? client.searchCompute(projectId, text, options) : client.search(projectId, text, options));
      if (request.signal.aborted) return;
      setPayload(next);
      setSelectedIndex(0);
      setCopiedId("");
      setMessage(
        next.results.length
          ? `找到 ${next.results.length} 条结果${next.mode === "vector" || next.mode === "hybrid" ? "（语义搜索）" : "（关键词）"}`
          : filter !== "all" ? `在${SOURCE_LABELS[filter]}中没有找到结果，可切换到「全部」。`
            : next.summary.documents === 0 ? "没有匹配结果。画面和对白尚未建立索引，也可以输入原片文件名。" : "没有找到匹配结果，试试更短的关键词。",
      );
    } catch (error) {
      if (request.signal.aborted) return;
      setFailed(true);
      setMessage(`搜索失败。 ${errorMessage(error)}`);
    } finally {
      if (!request.signal.aborted) {
        pending.current = null;
        setBusy(false);
      }
    }
  }

  function close(): void {
    if (pending.current) clearResults();
    setOpen(false);
    triggerRef.current?.focus();
  }

  function copyEvidence(result: SemanticSearchResult): void {
    const title = typeof result.metadata?.file_name === "string" ? result.metadata.file_name
      : result.group_id ? `Take ${result.group_id}` : "独立场记素材";
    const time = (result.source === "speech" || result.end > result.start) ? `${result.start.toFixed(2)}s` : "";
    const text = [title, time, result.snippet].filter(Boolean).join(" · ");
    void globalThis.navigator?.clipboard?.writeText?.(text).then(() => {
      setCopiedId(result.document_id);
      globalThis.setTimeout(() => setCopiedId((cur) => cur === result.document_id ? "" : cur), 1800);
    }).catch(() => undefined);
  }

  function dialogKeys(event: ReactKeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    const target = event.target as HTMLElement;
    if ((target === inputRef.current || target.closest(".semantic-search-result"))
      && (event.key === "ArrowDown" || event.key === "ArrowUp")) {
      const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>(".semantic-search-result:not(:disabled)")];
      if (!rows.length) return;
      const current = rows.findIndex(row => row === target);
      const step = event.key === "ArrowDown" ? 1 : -1;
      const index = current < 0 ? (step > 0 ? 0 : rows.length - 1) : (current + step + rows.length) % rows.length;
      event.preventDefault();
      rows[index].focus();
      return;
    }
    if (event.key === "Enter" && target === inputRef.current && activeResult && canOpenEvidence(activeResult)) {
      event.preventDefault();
      close();
      onOpenEvidence(activeResult);
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>("button:not(:disabled), input")];
    if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }

  const shortcut = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘K" : "Ctrl+K";

  return (
    <>
      <button ref={triggerRef} type="button" className="project-search-trigger" onClick={show}>
        <StudioIcon name="search" size={13} />
        <span>搜索</span>
        <kbd>{shortcut}</kbd>
      </button>
      {active && open ? (
        <div className="semantic-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section className="semantic-search-palette" role="dialog" aria-modal="true" aria-label="搜索项目素材" onKeyDown={dialogKeys}>
            <form className="semantic-search-form" onSubmit={(event) => { event.preventDefault(); if (!busy) void search(); }}>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => { setQuery(event.target.value); clearResults(); }}
                aria-label="搜索画面、对白或场记"
                placeholder="文件名、实际对白、场记或画面"
                autoComplete="off"
              />
              <button type="submit" disabled={busy || !query.trim()}>{busy ? "搜索中" : "搜索"}</button>
              <button type="button" className="secondary" disabled={busy || !query.trim()} onClick={() => void search(true)}>语义搜索</button>
            </form>
            <div className="semantic-search-filters">
              {(["all", "visual", "speech", "slate"] as SourceFilter[]).map((value) => (
                <button type="button" className={source === value ? "is-active" : ""} aria-pressed={source === value} key={value} onClick={() => {
                  if (value === source) return;
                  setSource(value);
                  if (submittedQuery.current) void search(false, value);
                }}>{value === "all" ? "全部" : SOURCE_LABELS[value]}</button>
              ))}
            </div>
            <p className="semantic-search-message" role={failed ? "alert" : "status"}>{message}</p>
            <div className={`semantic-search-body${results.length ? " has-preview" : ""}`}>
              <div className="semantic-search-results">
                {results.map((result, index) => (
                  <button
                    type="button"
                    className={`semantic-search-result${index === selectedIndex ? " is-selected" : ""}`}
                    key={result.document_id}
                    disabled={!canOpenEvidence(result)}
                    onMouseEnter={() => setSelectedIndex(index)}
                    onFocus={() => setSelectedIndex(index)}
                    onClick={() => { close(); onOpenEvidence(result); }}
                  >
                    <span className="semantic-result-source">{SOURCE_LABELS[result.source] || result.source_label || result.source}</span>
                    <span className="semantic-result-main">
                      <strong>{typeof result.metadata?.file_name === "string" ? result.metadata.file_name
                        : result.group_id ? `Take ${result.group_id}` : "独立场记素材"}</strong>
                      <small>{result.snippet || "没有可显示的片段"}</small>
                    </span>
                    <span className="semantic-result-time">{(result.source === "speech" || result.end > result.start) ? `${result.start.toFixed(2)}s` : ""}</span>
                  </button>
                ))}
              </div>
              {activeResult ? (
                <aside className="semantic-search-preview" aria-label="命中证据预览">
                  <div className="semantic-preview-meta">
                    <span className="semantic-result-source">{SOURCE_LABELS[activeResult.source] || activeResult.source_label || activeResult.source}</span>
                    {(activeResult.source === "speech" || activeResult.end > activeResult.start) ? (
                      <span className="semantic-preview-tc">{activeResult.start.toFixed(2)}s{activeResult.end > activeResult.start ? ` – ${activeResult.end.toFixed(2)}s` : ""}</span>
                    ) : null}
                  </div>
                  <strong className="semantic-preview-title">
                    {typeof activeResult.metadata?.file_name === "string" ? activeResult.metadata.file_name
                      : activeResult.group_id ? `Take ${activeResult.group_id}` : "独立场记素材"}
                  </strong>
                  <p className="semantic-preview-snippet">{activeResult.snippet || "没有可显示的片段文本。"}</p>
                  <div className="semantic-preview-actions">
                    <button type="button" disabled={!canOpenEvidence(activeResult)} onClick={() => { close(); onOpenEvidence(activeResult); }}>
                      定位到素材
                    </button>
                    <button type="button" className="secondary" onClick={() => copyEvidence(activeResult)}>
                      {copiedId === activeResult.document_id ? "已复制摘录" : "复制摘录与时间"}
                    </button>
                  </div>
                </aside>
              ) : null}
            </div>
            <footer className="semantic-search-footer">
              <span>{results.length ? "↑↓ 选择结果 · Enter 定位素材" : "Enter 搜索"} · Esc 关闭</span>
              <button type="button" className="secondary" onClick={close}>关闭</button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
