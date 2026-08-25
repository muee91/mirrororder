import { useEffect, useMemo, useState } from "react";
import { HostConnectionError } from "../../api/host";
import { ProductionClient, type IdentityRow } from "../../api/production";

interface Props {
  baseUrl: string;
  projectId: string;
  onOpenTake?: (groupId: string) => void;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function identityTitle(row: IdentityRow): string {
  return row.role_name || row.label || `${row.kind} · ${row.identity_id.slice(0, 10)}`;
}

export function IdentityWorkbench({ baseUrl, projectId, onOpenTake }: Props) {
  const client = useMemo(() => new ProductionClient(baseUrl), [baseUrl]);
  const [kind, setKind] = useState<"" | "face" | "speaker">("");
  const [rows, setRows] = useState<IdentityRow[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [label, setLabel] = useState("");
  const [roleName, setRoleName] = useState("");
  const [message, setMessage] = useState("正在读取本机人物库…");
  const [busy, setBusy] = useState(false);

  async function reload(nextKind = kind): Promise<void> {
    setMessage("正在读取本机人物库…");
    try {
      const payload = await client.identities(projectId, nextKind);
      setRows(payload.identities);
      setSelectedId((current) => payload.identities.some((row) => row.identity_id === current) ? current : payload.identities[0]?.identity_id ?? "");
      setMessage(`${payload.identities.length} 个本机 identity · embedding 不出设备`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void reload(kind);
    // client is memoized by baseUrl and projectId is explicit input.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId, kind]);

  const selected = rows.find((row) => row.identity_id === selectedId) ?? null;

  useEffect(() => {
    setLabel(selected?.label ?? "");
    setRoleName(selected?.role_name ?? "");
  }, [selected?.identity_id, selected?.label, selected?.role_name]);

  async function confirm(): Promise<void> {
    if (!selected) return;
    setBusy(true);
    setMessage("正在写入人工身份确认…");
    try {
      const saved = await client.confirmIdentity(projectId, {
        identityId: selected.identity_id,
        label,
        roleName,
      });
      setRows((current) => current.map((row) => row.identity_id === saved.identity_id ? saved : row));
      setMessage(`已人工确认 ${identityTitle(saved)}；自动聚类不会覆盖该标签。`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const suggestion = selected?.role_candidates?.[0] ?? null;

  return (
    <section className="phase3-workbench">
      <header className="production-heading">
        <div>
          <p className="eyebrow">Identity</p>
          <h2>人物 / 声音身份</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="identity-filter">
        {(["", "face", "speaker"] as const).map((value) => (
          <button type="button" key={value || "all"} className={kind === value ? "is-active" : ""} onClick={() => setKind(value)}>
            {value === "" ? "全部" : value === "face" ? "人脸" : "说话人"}
          </button>
        ))}
      </div>

      <div className="production-grid identity-grid">
        <div className="identity-list production-panel">
          {rows.length ? rows.map((row) => (
            <button type="button" className={`identity-row ${row.identity_id === selectedId ? "is-selected" : ""}`} key={row.identity_id} onClick={() => setSelectedId(row.identity_id)}>
              <span className="identity-kind">{row.kind}</span>
              <strong>{identityTitle(row)}</strong>
              <span>{row.take_count} Take · {(row.average_confidence * 100).toFixed(0)}%</span>
              {row.confirmed ? <em>人工确认</em> : row.suggested_role_name ? <em>建议 {row.suggested_role_name}</em> : null}
            </button>
          )) : <p className="empty-copy">还没有可浏览的 identity。先完成本机 identity index。</p>}
        </div>

        <aside className="production-panel identity-inspector">
          {selected ? (
            <>
              <div className="parse-heading">
                <div><p className="eyebrow">{selected.kind}</p><strong>{selected.identity_id}</strong></div>
                <span>{selected.confirmed ? "human confirmed" : "derived cluster"}</span>
              </div>
              <label className="production-field"><span>显示标签</span><input value={label} onChange={(event) => setLabel(event.target.value)} placeholder="例如：演员姓名 / 声音备注" /></label>
              <label className="production-field"><span>角色名</span><input value={roleName} onChange={(event) => setRoleName(event.target.value)} placeholder="例如：林夏" /></label>

              {suggestion ? (
                <div className="identity-suggestion">
                  <p className="eyebrow">角色建议 · 不是权威</p>
                  <strong>{suggestion.role_name}</strong>
                  <span>置信 {(suggestion.confidence * 100).toFixed(0)}% · {suggestion.supporting_takes} Take 支撑</span>
                  <button type="button" className="secondary" onClick={() => setRoleName(suggestion.role_name)}>采用到编辑框</button>
                </div>
              ) : null}

              <button type="button" disabled={busy} onClick={() => void confirm()}>人工确认身份</button>

              <div className="identity-occurrences">
                <p className="eyebrow">出现位置</p>
                {selected.occurrences.slice(0, 8).map((occurrence) => (
                  <button type="button" className="occurrence-row" key={`${occurrence.group_id}-${occurrence.clip_id}`} onClick={() => onOpenTake?.(occurrence.group_id)}>
                    <strong>{occurrence.group_id}</strong>
                    <span>{occurrence.camera || "—"} · {(occurrence.confidence * 100).toFixed(0)}%</span>
                    {occurrence.transcript_text ? <small>{occurrence.transcript_text}</small> : null}
                  </button>
                ))}
              </div>
            </>
          ) : <p className="empty-copy">选择一个 identity 查看证据。</p>}
        </aside>
      </div>
    </section>
  );
}
