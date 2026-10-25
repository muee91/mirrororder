import { useEffect, useMemo, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { errorMessage } from "../../api/host";
import { SemanticSearchClient, type SemanticSearchPayload } from "../../api/semantic";
import "./semantic-search.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenTake: (groupId: string) => void;
}

type SourceFilter = "all" | "visual" | "speech" | "slate";

const SOURCE_LABELS: Record<string, string> = {
  visual: "画面",
  speech: "对白",
  slate: "场记",
};


export function SemanticSearchPalette({ baseUrl, projectId, onOpenTake }: Props) {
  const client = useMemo(() => new SemanticSearchClient(baseUrl), [baseUrl]);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<SourceFilter>("all");
  const [payload, setPayload] = useState<SemanticSearchPayload | null>(null);
  const [message, setMessage] = useState("搜索已经生成的画面、对白和人工场记证据。");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent): void {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen(true);
        globalThis.requestAnimationFrame(() => inputRef.current?.focus());
      }
      if (event.key === "Escape") setOpen(false);
    }
    globalThis.addEventListener("keydown", onKeyDown);
    return () => globalThis.removeEventListener("keydown", onKeyDown);
  }, []);

  useEffect(() => {
    setPayload(null);
    setMessage("搜索已经生成的画面、对白和人工场记证据。");
  }, [projectId]);

  function show(): void {
    setOpen(true);
    globalThis.requestAnimationFrame(() => inputRef.current?.focus());
  }

  async function search(event?: FormEvent): Promise<void> {
    event?.preventDefault();
    if (!query.trim() || busy) return;
    setBusy(true);
    setMessage("正在检索当前项目证据…");
    try {
      const next = await client.searchCompute(projectId, query, {
        limit: 20,
        sources: source === "all" ? undefined : [source],
      });
      setPayload(next);
      setMessage(
        next.results.length
          ? `找到 ${next.results.length} 条相关制作证据${next.mode === "vector" || next.mode === "hybrid" ? "（向量语义）" : "（关键词）"}`
          : "没有找到足够相关的制作证据；可以换一个更具体的动作、对白或场记关键词。 ",
      );
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  function openResult(groupId: string): void {
    if (!groupId) return;
    setOpen(false);
    onOpenTake(groupId);
  }

  function handleInputKeyDown(event: ReactKeyboardEvent<HTMLInputElement>): void {
    if (event.key === "Escape") {
      event.preventDefault();
      setOpen(false);
    }
  }

  return (
    <>
      <button type="button" className="project-search-trigger" onClick={show} title="搜索项目证据 · ⌘K">搜索 <kbd>⌘K</kbd></button>
      {open ? (
        <div className="semantic-search-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) setOpen(false); }}>
          <section className="semantic-search-palette" role="dialog" aria-modal="true" aria-label="搜索项目证据">
            <form className="semantic-search-form" onSubmit={(event) => void search(event)}>
              <input
                ref={inputRef}
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                onKeyDown={handleInputKeyDown}
                placeholder="搜索画面、对白或场记，例如：林雪推门后回头"
                autoComplete="off"
              />
              <button type="submit" disabled={busy || !query.trim()}>{busy ? "搜索中" : "搜索"}</button>
            </form>
            <div className="semantic-search-filters">
              {(["all", "visual", "speech", "slate"] as SourceFilter[]).map((value) => (
                <button type="button" className={source === value ? "is-active" : ""} key={value} onClick={() => setSource(value)}>{value === "all" ? "全部" : SOURCE_LABELS[value]}</button>
              ))}
            </div>
            <p className="semantic-search-message">{message}</p>
            <div className="semantic-search-results">
              {(payload?.results ?? []).map((result) => (
                <button
                  type="button"
                  className="semantic-search-result"
                  key={result.document_id}
                  disabled={!result.group_id}
                  onClick={() => openResult(result.group_id)}
                >
                  <span className="semantic-result-source">{SOURCE_LABELS[result.source] || result.source_label || result.source}</span>
                  <span className="semantic-result-main">
                    <strong>{result.group_id ? `Take ${result.group_id}` : "独立场记素材"}</strong>
                    <small>{result.snippet || "没有可显示的片段"}</small>
                  </span>
                  <span className="semantic-result-time">{result.start > 0 ? `${result.start.toFixed(1)}s` : ""}</span>
                </button>
              ))}
              {payload && payload.results.length === 0 ? <div className="semantic-search-empty">当前索引没有匹配结果。</div> : null}
            </div>
            <footer className="semantic-search-footer">
              <span>检索结果是制作证据，不是 Best / Reject、人工归集或最终 Editorial Decision。</span>
              <button type="button" className="secondary" onClick={() => setOpen(false)}>关闭 Esc</button>
            </footer>
          </section>
        </div>
      ) : null}
    </>
  );
}
