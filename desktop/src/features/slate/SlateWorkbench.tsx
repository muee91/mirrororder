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

    const entry: Partial<SlateEntry> = {
      note: parsed.note,
      angles,
    };
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
    <section className="phase3-workbench">
      <header className="production-heading">
        <div>
          <p className="eyebrow">现场记录</p>
          <h2>场记</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="production-grid slate-grid">
        <aside className="production-panel">
          <label className="production-field">
            <span>Take</span>
            <select value={selectedGroupId} onChange={(event) => { setSelectedGroupId(event.target.value); setParsed(null); setQuickText(""); globalThis.requestAnimationFrame(() => quickInputRef.current?.focus()); }}>
              {takes.map((take) => (
                <option value={take.group_id} key={take.group_id}>{takeLabel(take)}</option>
              ))}
            </select>
          </label>
          <div className="production-actions">
            <button type="button" className="secondary" disabled={busy || selectedIndex <= 0} onClick={() => moveTake(-1)}>上一条 · ⌥↑</button>
            <button type="button" className="secondary" disabled={busy || selectedIndex < 0 || selectedIndex >= takes.length - 1} onClick={() => moveTake(1)}>下一条 · ⌥↓</button>
          </div>
          <label className="production-field">
            <span>操作者昵称</span>
            <input value={actor} onChange={(event) => setActor(event.target.value)} placeholder="写入时必填" />
          </label>

          <div className="slate-current">
            <p className="eyebrow">当前记录</p>
            {existing ? (
              <>
                <strong>{[existing.episode ? `EP${existing.episode}` : "", existing.scene, existing.shot, existing.take_number ? `T${existing.take_number}` : ""].filter(Boolean).join(" · ") || "已记录"}</strong>
                <span>{existing.status} · {existing.actor || "未知操作者"}</span>
                <p>{existing.note || "没有备注"}</p>
              </>
            ) : <p>这个 Take 还没有人工场记。</p>}
          </div>
        </aside>

        <div className="production-panel slate-capture">
          <p className="eyebrow">快速录入</p>
          <textarea
            ref={quickInputRef}
            value={quickText}
            onChange={(event) => { setQuickText(event.target.value); if (parsed) setParsed(null); }}
            onKeyDown={handleQuickKeyDown}
            placeholder="例如：EP3 12-3-2 B近 前半段可用；或：同场下一条 C特 看片再定"
            rows={6}
          />
          <div className="production-actions">
            <button type="button" disabled={busy || !quickText.trim() || !selectedTake} onClick={() => void parseQuickEntry()}>解析 · ⌘/Ctrl+Enter</button>
            <span>⌥↑/⌥↓ 切 Take；解析后再次 ⌘/Ctrl+Enter 确认写入并自动进入下一条。</span>
          </div>

          {parsed ? (
            <div className="parse-preview">
              <div className="parse-heading">
                <div>
                  <p className="eyebrow">待确认</p>
                  <strong>{parseSummary(parsed)}</strong>
                </div>
                <span>已解析</span>
              </div>
              <p>{parsed.note}</p>
              {Object.keys(parsed.angle_shots).length ? (
                <div className="fact-chips">
                  {Object.entries(parsed.angle_shots).map(([camera, shot]) => <span key={camera}>{camera} · {shot}</span>)}
                </div>
              ) : null}
              {parsed.generic_shot ? <p className="production-warning">检测到通用景别 {parsed.generic_shot}；不会自动复制到 A/B/C，请按机位明确后再写。</p> : null}
              {parsed.range_hint ? <p className="production-note">范围提示：{parsed.range_hint}。原话保留在 note，不生成虚构秒数。</p> : null}
              <button type="button" disabled={busy || !actor.trim()} onClick={() => void confirmParsed()}>确认写入 · ⌘/Ctrl+Enter</button>
            </div>
          ) : null}
        </div>
      </div>
    </section>
  );
}
