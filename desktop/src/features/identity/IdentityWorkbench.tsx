import { useEffect, useMemo, useState } from "react";
import { HostConnection, HostConnectionError } from "../../api/host";
import { ProductionClient, type IdentityOccurrence, type IdentityRow } from "../../api/production";
import { MirrorOrderMediaCard, type MirrorOrderMediaCardModel } from "../media/MirrorOrderMediaCard";
import { confidenceLabel, IdentityCandidateRow, IdentityPortrait, identityTitle, PersonRow } from "./IdentityRows";
import "./identity-workbench.css";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenTake?: (groupId: string) => void;
}

type VisualIdentityOccurrence = IdentityOccurrence & {
  media_id?: string;
  name?: string;
  duration?: number;
  shot_type?: string;
};

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function sourceTimeLabel(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "时间未知";
  const whole = Math.floor(seconds);
  const minutes = Math.floor(whole / 60);
  const rest = whole % 60;
  return `${minutes}:${String(rest).padStart(2, "0")}`;
}

function evidenceCard(host: HostConnection, projectId: string, occurrence: VisualIdentityOccurrence): MirrorOrderMediaCardModel {
  const observedDuration = Math.max(0, Number(occurrence.end || 0) - Number(occurrence.start || 0));
  return {
    id: `${occurrence.group_id}:${occurrence.clip_id}`,
    mediaId: occurrence.media_id || occurrence.clip_id,
    camera: occurrence.camera || "—",
    name: occurrence.name || occurrence.clip_id || occurrence.group_id,
    duration: typeof occurrence.duration === "number" && occurrence.duration > 0 ? occurrence.duration : observedDuration,
    shotType: occurrence.shot_type || "unknown",
    playbackUrl: occurrence.clip_id ? host.mediaUrl(projectId, occurrence.clip_id) : undefined,
    sourceStart: occurrence.source_time,
  };
}

export function IdentityWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const client = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const host = useMemo(() => new HostConnection(baseUrl), [baseUrl]);
  const [kind, setKind] = useState<"" | "face" | "speaker">("");
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [label, setLabel] = useState("");
  const [roleName, setRoleName] = useState("");
  const [message, setMessage] = useState("正在更新人物识别…");
  const [busy, setBusy] = useState(false);

  async function reload(): Promise<void> {
    setMessage("正在更新人物识别…");
    try {
      const payload = await client.identities(projectId, "");
      setRows(payload.identities);
      setSelectedId((current) => payload.identities.some((row) => row.identity_id === current)
        ? current
        : payload.identities[0]?.identity_id ?? "");
      setMessage(`已找到 ${payload.identities.length} 组人物线索`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void reload();
    // client is memoized by baseUrl and projectId is explicit input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId]);

  const visibleRows = useMemo(
    () => kind ? rows.filter((row) => row.kind === kind) : rows,
    [kind, rows],
  );
  const faceCount = useMemo(() => rows.filter((row) => row.kind === "face").length, [rows]);
  const speakerCount = useMemo(() => rows.filter((row) => row.kind === "speaker").length, [rows]);

  useEffect(() => {
    if (visibleRows.some((row) => row.identity_id === selectedId)) return;
    setSelectedId(visibleRows[0]?.identity_id ?? "");
  }, [selectedId, visibleRows]);

  const selected = rows.find((row) => row.identity_id === selectedId) ?? null;
  const selectedIndex = selected ? Math.max(0, rows.findIndex((row) => row.identity_id === selected.identity_id)) : 0;

  useEffect(() => {
    setLabel(selected?.label ?? "");
    setRoleName(selected?.role_name ?? "");
  }, [selected?.identity_id, selected?.label, selected?.role_name]);

  async function confirm(nextRoleName = roleName): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setMessage(selected.confirmed ? "正在保存身份修改…" : "正在确认身份…");
    try {
      const saved = await client.confirmIdentity(projectId, {
        identityId: selected.identity_id,
        label,
        roleName: nextRoleName,
      });
      setRows((current) => current.map((row) => row.identity_id === saved.identity_id ? saved : row));
      setRoleName(saved.role_name);
      setLabel(saved.label);
      setMessage(`已确认 ${saved.role_name || saved.label || "这个身份"}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const suggestion = selected?.role_candidates?.[0] ?? null;
  const canConfirm = Boolean(label.trim() || roleName.trim());

  return (
    <section className="phase3-workbench identity-workbench">
      <div className="identity-toolbar">
        <div className="identity-filter" aria-label="人物类型筛选">
          <button type="button" className={kind === "" ? "is-active" : ""} onClick={() => setKind("")}>
            全部 <small>{rows.length}</small>
          </button>
          <button type="button" className={kind === "face" ? "is-active" : ""} onClick={() => setKind("face")}>
            人脸 <small>{faceCount}</small>
          </button>
          <button type="button" className={kind === "speaker" ? "is-active" : ""} onClick={() => setKind("speaker")}>
            声纹 <small>{speakerCount}</small>
          </button>
        </div>
        <span className="identity-toolbar-status" role="status">{message}</span>
      </div>

      <div className="production-grid identity-grid">
        <div className="identity-list production-panel" aria-label="人物线索">
          {visibleRows.length ? visibleRows.map((row) => {
            const rowIndex = Math.max(0, rows.findIndex((item) => item.identity_id === row.identity_id));
            const rowProps = {
              baseUrl,
              projectId,
              row,
              index: rowIndex,
              selected: row.identity_id === selectedId,
              onSelect: () => setSelectedId(row.identity_id),
            };
            return row.confirmed
              ? <PersonRow key={row.identity_id} {...rowProps} />
              : <IdentityCandidateRow key={row.identity_id} {...rowProps} />;
          }) : <p className="empty-copy">当前筛选下还没有人物线索。</p>}
        </div>

        <aside className="production-panel identity-inspector" aria-label="人物确认">
          {selected ? (
            <>
              <div className="identity-inspector-body">
                <header className="identity-person-header">
                  <IdentityPortrait
                    baseUrl={baseUrl}
                    projectId={projectId}
                    row={selected}
                    title={identityTitle(selected, selectedIndex)}
                    large
                    eager
                  />
                  <span className="identity-person-copy">
                    <span className="identity-person-state">{selected.confirmed ? "已确认" : "待确认"}</span>
                    <strong>{identityTitle(selected, selectedIndex)}</strong>
                    <small>{selected.take_count} 个 Take · 平均匹配 {confidenceLabel(selected.average_confidence)}</small>
                  </span>
                </header>

                {suggestion && !selected.confirmed ? (
                  <section className="identity-suggestion" aria-label="系统角色建议">
                    <div>
                      <span>系统建议</span>
                      <strong>{suggestion.role_name}</strong>
                      <small>基于 {suggestion.supporting_takes} 个 Take · 匹配 {confidenceLabel(suggestion.confidence)}</small>
                    </div>
                    <button type="button" disabled={busy} onClick={() => { setRoleName(suggestion.role_name); void confirm(suggestion.role_name); }}>
                      确认是“{suggestion.role_name}”
                    </button>
                  </section>
                ) : null}

                <section className="identity-edit-section">
                  <div className="identity-section-heading">
                    <strong>身份信息</strong>
                    <span>用于场记、素材和审阅中的人物显示</span>
                  </div>
                  <div className="identity-edit-grid">
                    <label className="production-field">
                      <span>姓名或备注</span>
                      <input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：演员姓名" />
                    </label>
                    <label className="production-field">
                      <span>角色</span>
                      <input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="例如：林夏" />
                    </label>
                  </div>
                </section>

                <section className="identity-evidence-section">
                  <div className="identity-section-heading">
                    <strong>识别依据</strong>
                    <span>{selected.occurrences.length} 处匹配 · 直接看机位画面，点击回到对应 Take</span>
                  </div>
                  <div className="identity-evidence-cards">
                    {selected.occurrences.slice(0, 12).map((rawOccurrence) => {
                      const occurrence = rawOccurrence as VisualIdentityOccurrence;
                      const model = evidenceCard(host, projectId, occurrence);
                      return (
                        <div className="identity-evidence-card" key={`${occurrence.group_id}-${occurrence.clip_id}`}>
                          <MirrorOrderMediaCard
                            model={model}
                            compact
                            onSelect={onOpenTake && occurrence.group_id ? () => onOpenTake(occurrence.group_id) : undefined}
                          />
                          <div className="identity-evidence-meta">
                            <strong>匹配 {confidenceLabel(occurrence.confidence)}</strong>
                            <span>{sourceTimeLabel(occurrence.source_time)}</span>
                          </div>
                          {occurrence.transcript_text ? <p>{occurrence.transcript_text}</p> : null}
                        </div>
                      );
                    })}
                    {!selected.occurrences.length ? <p className="empty-copy">暂时没有可回看的匹配位置。</p> : null}
                  </div>
                </section>

                <details className="identity-technical">
                  <summary>技术信息</summary>
                  <dl>
                    <div><dt>身份 ID</dt><dd>{selected.identity_id}</dd></div>
                    <div><dt>识别类型</dt><dd>{selected.kind === "speaker" ? "speaker / 声纹" : "face / 人脸"}</dd></div>
                    <div><dt>观察数</dt><dd>{selected.observation_count}</dd></div>
                    <div><dt>示例 Take</dt><dd>{selected.example_group_id || "—"}</dd></div>
                  </dl>
                </details>
              </div>

              <footer className="identity-confirm-bar">
                <span>
                  <strong>{selected.confirmed ? "这个身份已经人工确认" : "确认后自动聚类不会覆盖你的判断"}</strong>
                  <small>{canConfirm ? "保存姓名或角色，并把它作为人工事实。" : "填写姓名或角色后即可确认。"}</small>
                </span>
                <button type="button" disabled={busy || !canConfirm} onClick={() => void confirm()}>
                  {busy ? "保存中…" : selected.confirmed ? "保存修改" : "确认身份"}
                </button>
              </footer>
            </>
          ) : <p className="empty-copy identity-empty-inspector">从左侧选择一组人物线索，查看依据并确认身份。</p>}
        </aside>
      </div>
    </section>
  );
}
