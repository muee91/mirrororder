import { useEffect, useLayoutEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { errorMessage } from "../../api/host";
import { SemanticSearchClient, type SemanticSearchPayload, type SemanticSearchResult } from "../../api/semantic";
import { canOpenEvidence } from "../production/evidenceLocation";
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
  const [message, setMessage] = useState("搜索已经生成的画面、对白和人工场记证据。");
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  const inFlight = useRef(false);

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

  useEffect(() => {
    setPayload(null);
    setMessage("搜索已经生成的画面、对白和人工场记证据。");
  }, [projectId]);

  function show(): void {
    setOpen(true);
    inputRef.current?.focus();
  }

  async function search(event?: FormEvent, semantic = false): Promise<void> {
    event?.preventDefault();
    if (!query.trim() || inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    setFailed(false);
    setPayload(null);
    setMessage("正在检索当前项目证据…");
    try {
      const options = {
        limit: 20,
        sources: source === "all" ? undefined : [source],
      };
      const next = await (semantic ? client.searchCompute(projectId, query, options) : client.search(projectId, query, options));
      setPayload(next);
      setSelectedIndex(0);
      setCopiedId("");
      setMessage(
        next.results.length
          ? `找到 ${next.results.length} 条相关制作证据${next.mode === "vector" || next.mode === "hybrid" ? "（向量语义）" : "（关键词）"}`
          : next.summary.documents === 0 ? "还没有可检索的画面或对白索引。" : "没有找到匹配证据。",
      );
    } catch (error) {
      setFailed(true);
      setMessage(`搜索失败。 ${errorMessage(error)}`);
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  function close(): void {
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
    if (results.length > 0 && event.key === "ArrowDown") {
      event.preventDefault();
      setSelectedIndex((current) => (current + 1) % results.length);
      return;
    }
    if (results.length > 0 && event.key === "ArrowUp") {
      event.preventDefault();
      setSelectedIndex((current) => (current - 1 + results.length) % results.length);
      return;
    }
    if (event.key === "Enter" && activeResult && canOpenEvidence(activeResult) && event.target !== inputRef.current) {
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
      <button ref={triggerRef} type="button" className="project-search-trigger" onClick={show}>搜索 <kbd>{shortcut}</kbd></button>
      {active && open ? (
        <div className="semantic-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
          <section className="semantic-search-palette" role="dialog" aria-modal="true" aria-label="搜索项目证据" onKeyDown={dialogKeys}>
            <form className="semantic-search-form" onSubmit={(event) => void search(event)}>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                aria-label="搜索画面、对白或场记"
                placeholder="文件名、实际对白、场记或画面"
                autoComplete="off"
              />
              <button type="submit" disabled={busy || !query.trim()}>{busy ? "搜索中" : "搜索"}</button>
              <button type="button" className="secondary" disabled={busy || !query.trim()} onClick={() => void search(undefined, true)}>语义搜索</button>
            </form>
            <div className="semantic-search-filters">
              {(["all", "visual", "speech", "slate"] as SourceFilter[]).map((value) => (
                <button type="button" className={source === value ? "is-active" : ""} aria-pressed={source === value} key={value} onClick={() => setSource(value)}>{value === "all" ? "全部" : SOURCE_LABELS[value]}</button>
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
                      打开证据定位
                    </button>
                    <button type="button" className="secondary" onClick={() => copyEvidence(activeResult)}>
                      {copiedId === activeResult.document_id ? "已复制摘录" : "复制摘录与时间"}
                    </button>
                  </div>
                </aside>
              ) : null}
            </div>
            <footer className="semantic-search-footer">
              <span>↑↓ 切换结果 · Enter 定位证据 · Esc 关闭</span>
              <button type="button" className="secondary" onClick={close}>关闭</button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
