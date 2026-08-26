import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { HostConnection, HostConnectionError, type ReviewModelPayload, type ReviewTakeGroup } from "../../api/host";
import { ProductionClient, type SlateBoard, type SlateEntry, type SlateParseResult } from "../../api/production";

interface Props {
  baseUrl: string;
  projectId: string;
}

const ACTOR_KEY = "mirrororder.desktop.review-actor";

function readActor(): string {
  try {
    return globalThis.localStorage?.getItem(ACTOR_KEY)?.trim() ?? "";
  } catch {
    return "";
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function takeLabel(take: ReviewTakeGroup): string {
  const cameras = take.angles.map((angle) => angle.camera).filter(Boolean).join("/");
  return `${take.group_id}${cameras ? ` · ${cameras}` : ""}`;
}

function parseSummary(result: SlateParseResult): string {
  const bits = [
    result.episode ? `EP${result.episode}` : "",
    result.scene ? `场 ${result.scene}` : "",
    result.shot ? `镜 ${result.shot}` : "",
    result.take_number ? `第 ${result.take_number} 条` : "",
    result.status !== "unmarked" ? result.status : "",
  ].filter(Boolean);
  return bits.join(" · ") || "只记录原始备注";
}

function entryAngles(take: ReviewTakeGroup, entry: SlateEntry | null): string[] {
  return take.angles.map((angle) => {
    const shot = entry?.angles?.[angle.clip_id]?.shot_type || "—";
    return `${angle.camera || "—"}:${shot}`;
  });
}

function statusLabel(value: string): string {
  return {
    usable: "可用",
    partial: "部分可用",
    ng: "NG",
    unmarked: "未标记",
  }[value] ?? value;
}

export function SlateWorkbench({ baseUrl, projectId }: Props) {
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const production = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const [review, setReview] = useState<ReviewModelPayload | null>(null);
  const [board, setBoard] = useState<SlateBoard | null>(null);
  const [selectedGroupId, setSelectedGroupId] = useState("");
  const [quickText, setQuickText] = useState("");
  const [parsed, setParsed] = useState<SlateParseResult | null>(null);
  const [actor, setActor] = useState(readActor);
  const [message, setMessage] = useState("正在读取电子场记…");
  const [busy, setBusy] = useState(false);
  const quickInputRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setMessage("正在读取电子场记…");
    Promise.all([host.reviewModel(projectId), production.scriptSupervisor(projectId)])
      .then(([nextReview, nextBoard]) => {
        if (cancelled) return;
        setReview(nextReview);
        setBoard(nextBoard);
        setSelectedGroupId((current) => current || nextReview.take_groups[0]?.group_id || "");
        setMessage(`场记已同步 · r${nextBoard.revision}`);
        globalThis.requestAnimationFrame(() => quickInputRef.current?.focus());
      })
      .catch((error) => {
        if (!cancelled) setMessage(errorMessage(error));
      });
    return () => { cancelled = true; };
  }, [host, production, projectId]);

  const takes = review?.take_groups ?? [];
  const selectedIndex = takes.findIndex((take) => take.group_id === selectedGroupId);
  const selectedTake = selectedIndex >= 0 ? takes[selectedIndex] : null;
  const existing = board?.entries[selectedGroupId] ?? null;

  function selectTakeAt(index: number): void {
    const next = takes[index];
    if (!next) return;
    setSelectedGroupId(next.group_id);
    setParsed(null);
    setQuickText("");
    globalThis.requestAnimationFrame(() => quickInputRef.current?.focus());
  }

  function selectTake(groupId: string): void {
    const nextIndex = takes.findIndex((take) => take.group_id === groupId);
    if (nextIndex >= 0) selectTakeAt(nextIndex);
  }

  function moveTake(delta: -1 | 1): void {
    if (!takes.length) return;
    const origin = selectedIndex >= 0 ? selectedIndex : 0;
    const next = Math.max(0, Math.min(takes.length - 1, origin + delta));
    if (next !== origin) selectTakeAt(next);
  }

  async function parseQuickEntry(): Promise<void> {
    if (!selectedTake || !quickText.trim()) return;
    setBusy(true);
    setMessage("正在解析场记原话…");
    try {
      const response = await production.parseSlate(projectId, quickText, existing ?? undefined);
      setParsed(response.result);
      setMessage("解析完成，请确认后写入。");
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function confirmParsed(): Promise<void> {
    if (!selectedTake || !board || !parsed) return;
    if (!actor.trim()) {
      setMessage("写入场记前需要操作者昵称。");
      return;
    }

    const angles: SlateEntry["angles"] = { ...(existing?.angles ?? {}) };
    for (const angle of selectedTake.angles) {
      const camera = angle.camera.trim().toUpperCase().replace(/机/g, "");
      const shotType = parsed.angle_shots[camera];
      if (shotType) {
        angles[angle.clip_id] = { shot_type: shotType, note: existing?.angles?.[angle.clip_id]?.note ?? "" };
      }
    }

    const entry: Partial<SlateEntry> = { note: parsed.note, angles };
    if (parsed.episode !== null) entry.episode = parsed.episode;
    if (parsed.scene) entry.scene = parsed.scene;
    if (parsed.shot) entry.shot = parsed.shot;
    if (parsed.take_number !== null) entry.take_number = parsed.take_number;
    if (parsed.status !== "unmarked" || !existing) entry.status = parsed.status;

    const completedIndex = selectedIndex;
    setBusy(true);
    setMessage("正在写入人工场记…");
    try {
      globalThis.localStorage?.setItem(ACTOR_KEY, actor.trim());
      const next = await production.writeSlateEntry(projectId, {
        groupId: selectedTake.group_id,
        expectedRevision: board.revision,
        actor,
        entry,
      });
      setBoard(next);
      setParsed(null);
      setQuickText("");
      const nextTake = takes[completedIndex + 1];
      if (nextTake) {
        setSelectedGroupId(nextTake.group_id);
        setMessage(`已写入 · r${next.revision} · 已进入下一条 Take`);
      } else {
        setMessage(`已写入 · r${next.revision} · 已到最后一条 Take`);
      }
      globalThis.requestAnimationFrame(() => quickInputRef.current?.focus());
    } catch (error) {
      setMessage(errorMessage(error));
      if (error instanceof HostConnectionError && error.status === 409) {
        try {
          const latest = await production.scriptSupervisor(projectId);
          setBoard(latest);
          setMessage(`场记已被其他操作更新，已刷新到 r${latest.revision}；请重新确认。`);
        } catch {
          // Preserve the original conflict message if refresh also fails.
        }
      }
    } finally {
      setBusy(false);
    }
  }

  function handleQuickKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): void {
    if (event.altKey && event.key === "ArrowUp") {
      event.preventDefault();
      moveTake(-1);
      return;
    }
    if (event.altKey && event.key === "ArrowDown") {
      event.preventDefault();
      moveTake(1);
      return;
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      if (busy) return;
      if (parsed) void confirmParsed();
      else if (quickText.trim()) void parseQuickEntry();
    }
  }

  return (
    <section className="phase3-workbench slate-table-workbench">
      <header className="production-heading slate-heading">
        <div><p className="eyebrow">现场记录</p><h2>电子场记</h2></div>
        <div className="slate-heading-status"><strong>{selectedTake ? takeLabel(selectedTake) : "未选择 Take"}</strong><span>{message}</span></div>
      </header>

      <section className="slate-entry-bar" aria-label="场记快速录入">
        <div className="slate-entry-context">
          <button type="button" className="secondary" disabled={busy || selectedIndex <= 0} onClick={() => moveTake(-1)}>⌥↑</button>
          <select value={selectedGroupId} onChange={(event) => selectTake(event.target.value)} aria-label="当前 Take">
            {takes.map((take) => <option value={take.group_id} key={take.group_id}>{takeLabel(take)}</option>)}
          </select>
          <button type="button" className="secondary" disabled={busy || selectedIndex < 0 || selectedIndex >= takes.length - 1} onClick={() => moveTake(1)}>⌥↓</button>
          <input className="slate-actor-input" value={actor} onChange={(event) => setActor(event.target.value)} placeholder="场记员" aria-label="操作者昵称" />
        </div>
        <textarea
          ref={quickInputRef}
          value={quickText}
          onChange={(event) => { setQuickText(event.target.value); if (parsed) setParsed(null); }}
          onKeyDown={handleQuickKeyDown}
          placeholder="快速录入：EP3 12-3-2 B近 前半段可用；同场下一条 C特 看片再定"
          rows={2}
        />
        <button type="button" className="slate-primary-action" disabled={busy || (!parsed && !quickText.trim()) || !selectedTake || (Boolean(parsed) && !actor.trim())} onClick={() => parsed ? void confirmParsed() : void parseQuickEntry()}>
          {parsed ? "确认写入 ⌘↵" : "解析 ⌘↵"}
        </button>
      </section>

      {parsed ? (
        <section className="slate-parse-inline">
          <div><span>待确认</span><strong>{parseSummary(parsed)}</strong><p>{parsed.note}</p></div>
          <div className="slate-parse-facts">
            {Object.entries(parsed.angle_shots).map(([camera, shot]) => <span key={camera}>{camera} · {shot}</span>)}
            {parsed.range_hint ? <span>范围：{parsed.range_hint}</span> : null}
            {parsed.generic_shot ? <em>通用景别 {parsed.generic_shot} 不会自动复制到所有机位</em> : null}
          </div>
        </section>
      ) : null}

      <div className="slate-table-shell">
        <table className="slate-table">
          <thead>
            <tr>
              <th className="slate-col-take">Take</th>
              <th>集</th>
              <th>场</th>
              <th>镜</th>
              <th>条</th>
              <th className="slate-col-angle">机位 / 景别</th>
              <th>状态</th>
              <th className="slate-col-note">备注</th>
              <th>记录人</th>
            </tr>
          </thead>
          <tbody>
            {takes.map((take) => {
              const entry = board?.entries[take.group_id] ?? null;
              const selected = take.group_id === selectedGroupId;
              return (
                <tr className={selected ? "is-selected" : ""} key={take.group_id} onClick={() => selectTake(take.group_id)}>
                  <td className="slate-col-take"><strong>{take.group_id}</strong><small>{take.angles.map((angle) => angle.camera).filter(Boolean).join("/") || "—"}</small></td>
                  <td>{entry?.episode ? `EP${entry.episode}` : "—"}</td>
                  <td>{entry?.scene || "—"}</td>
                  <td>{entry?.shot || "—"}</td>
                  <td>{entry?.take_number ?? "—"}</td>
                  <td className="slate-col-angle"><div className="slate-angle-values">{entryAngles(take, entry).map((value) => <span key={`${take.group_id}-${value}`}>{value}</span>)}</div></td>
                  <td><span className={`slate-status slate-status-${entry?.status || "unmarked"}`}>{statusLabel(entry?.status || "unmarked")}</span></td>
                  <td className="slate-col-note" title={entry?.note || ""}>{entry?.note || "—"}</td>
                  <td>{entry?.actor || "—"}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="production-note slate-keyboard-note">⌥↑ / ⌥↓ 切换 Take；⌘/Ctrl+Enter 解析，再按一次确认并自动进入下一条。场记只记录生产事实，不改写 Review placement 或最终 Editorial Decision。</p>
    </section>
  );
}
