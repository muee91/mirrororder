import { useEffect, useMemo, useState } from "react";
import { HostConnectionError } from "../../api/host";
import {
  MediaRoleClient,
  type MediaInventory,
  type MediaInventoryItem,
  type MediaRole,
  type MediaRoleStore,
  type MediaSourceRole,
} from "../../api/mediaRoles";
import { MediaBindingWorkbench } from "./MediaBindingWorkbench";
import "./media-library.css";

interface Props {
  baseUrl: string;
  projectId: string;
}

type Filter = "all" | "auxiliary" | "unindexed" | "labeled";

const ROLE_LABELS: Record<string, string> = {
  sync_camera: "同步机位",
  aerial: "航拍",
  broll: "空镜 / B-roll",
  gopro: "GoPro",
  insert: "细节 / Insert",
  custom: "自定义",
};

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function storedActor(): string {
  try {
    return globalThis.localStorage?.getItem("mirrororder.desktop-v2.review-actor")?.trim() ?? "";
  } catch {
    return "";
  }
}

function saveActor(actor: string): void {
  try { globalThis.localStorage?.setItem("mirrororder.desktop-v2.review-actor", actor.trim()); } catch { /* local convenience */ }
}

function roleFor(item: MediaInventoryItem, store: MediaRoleStore | null): MediaRole {
  return store?.media[item.media_id] ?? item.label ?? {};
}

function isAuxiliary(role: MediaRole): boolean {
  return Boolean((role.source_role && role.source_role !== "sync_camera") || role.sync_policy === "exclude");
}

function defaultDraft(item: MediaInventoryItem, store: MediaRoleStore | null): MediaRole {
  const role = roleFor(item, store);
  const sourceRole = role.source_role || "sync_camera";
  return {
    display_name: item.display_name,
    camera_override: role.camera_override || "",
    source_role: sourceRole,
    role_label: role.role_label || "",
    sync_policy: role.sync_policy || (sourceRole === "sync_camera" ? "auto" : "exclude"),
    scene_id: role.scene_id || "",
    note: role.note || "",
  };
}

function inventoryUpdatedLabel(value: string): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("zh-CN", { hour12: false });
}

export function MediaLibraryWorkbench({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new MediaRoleClient(baseUrl), [baseUrl]);
  const [inventory, setInventory] = useState<MediaInventory | null>(null);
  const [roles, setRoles] = useState<MediaRoleStore | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [draft, setDraft] = useState<MediaRole>({});
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const [actor, setActor] = useState(storedActor);
  const [message, setMessage] = useState("正在读取本机素材清单与共享素材角色…");
  const [busy, setBusy] = useState(false);
  const [showBinding, setShowBinding] = useState(false);

  async function reload(preferredId = selectedId): Promise<void> {
    setBusy(true);
    try {
      const [nextInventory, nextRoles] = await Promise.all([client.inventory(projectId), client.roles(projectId)]);
      setInventory(nextInventory);
      setRoles(nextRoles);
      const nextSelected = preferredId && nextInventory.items.some((item) => item.media_id === preferredId)
        ? preferredId
        : nextInventory.items[0]?.media_id ?? "";
      setSelectedId(nextSelected);
      const item = nextInventory.items.find((row) => row.media_id === nextSelected);
      setDraft(item ? defaultDraft(item, nextRoles) : {});
      const updated = inventoryUpdatedLabel(nextInventory.inventory_updated_at);
      if (nextInventory.scan_required) {
        setMessage(updated
          ? `素材清单需要重新扫描 · 上次清单 ${updated}`
          : "素材清单尚未扫描 · 请打开本机素材恢复提交扫描任务");
      } else {
        setMessage(`${nextInventory.summary.files} 素材 · ${nextInventory.summary.indexed} 已入索引 · ${nextInventory.summary.auxiliary} 辅助素材${updated ? ` · 清单 ${updated}` : ""}`);
      }
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  useEffect(() => { void reload(""); }, [client, projectId]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase("zh-CN");
    return (inventory?.items ?? []).filter((item) => {
      const role = roleFor(item, roles);
      if (filter === "auxiliary" && !isAuxiliary(role)) return false;
      if (filter === "unindexed" && item.indexed) return false;
      if (filter === "labeled" && Object.keys(role).length === 0) return false;
      if (!needle) return true;
      return [item.display_name, item.folder_label, item.inferred_camera, role.camera_override, role.source_role, role.role_label, role.scene_id, role.note]
        .join(" ")
        .toLocaleLowerCase("zh-CN")
        .includes(needle);
    });
  }, [filter, inventory, query, roles]);

  const visible = filtered.slice(0, 500);
  const selectedItem = inventory?.items.find((item) => item.media_id === selectedId) ?? null;

  function select(item: MediaInventoryItem): void {
    setSelectedId(item.media_id);
    setDraft(defaultDraft(item, roles));
  }

  function patch(patchValue: Partial<MediaRole>): void {
    setDraft((current) => ({ ...current, ...patchValue }));
  }

  async function save(): Promise<void> {
    if (!selectedItem || !roles) return;
    if (!actor.trim()) {
      setMessage("保存人工素材角色前需要操作者昵称。");
      return;
    }
    setBusy(true);
    saveActor(actor);
    setMessage("正在保存素材角色…");
    try {
      const next = await client.save(projectId, {
        expectedRevision: roles.revision,
        actor,
        mediaId: selectedItem.media_id,
        entry: {
          display_name: selectedItem.display_name,
          camera_override: draft.camera_override?.trim() || "",
          source_role: draft.source_role || "sync_camera",
          role_label: draft.role_label?.trim() || "",
          sync_policy: draft.sync_policy || ((draft.source_role || "sync_camera") === "sync_camera" ? "auto" : "exclude"),
          scene_id: draft.scene_id?.trim() || "",
          note: draft.note?.trim() || "",
        },
      });
      setRoles(next);
      await reload(selectedItem.media_id);
      setMessage(`素材角色已保存 · r${next.revision}`);
    } catch (error) {
      if (error instanceof HostConnectionError && error.status === 409) {
        await reload(selectedItem.media_id).catch(() => undefined);
        setMessage("素材角色已被其他操作更新，已刷新到最新状态；请重新确认。");
      } else {
        setMessage(errorMessage(error));
      }
    } finally {
      setBusy(false);
    }
  }

  function changeSourceRole(value: MediaSourceRole): void {
    patch({ source_role: value, sync_policy: value === "sync_camera" ? "auto" : "exclude" });
  }

  return (
    <section className="media-library-workbench">
      <header className="production-heading">
        <div><p className="eyebrow">素材 / Library</p><h2>素材库</h2></div>
        <div className="assistant-heading-actions"><span className="production-state">{message}</span><button type="button" className="secondary" disabled={busy} onClick={() => void reload()}>刷新</button></div>
      </header>

      <div className="media-library-summary">
        <span><strong>{inventory?.summary.files ?? 0}</strong>素材</span>
        <span><strong>{inventory?.summary.indexed ?? 0}</strong>已入索引</span>
        <span className={(inventory?.summary.unindexed ?? 0) ? "needs-attention" : ""}><strong>{inventory?.summary.unindexed ?? 0}</strong>未入索引</span>
        <span><strong>{inventory?.summary.labeled ?? 0}</strong>人工标记</span>
        <span><strong>{inventory?.summary.auxiliary ?? 0}</strong>辅助素材</span>
      </div>

      <div className="media-library-toolbar">
        <input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索文件、机位、场景或备注" />
        <div className="media-library-filters">
          {([[
            "all", "全部",
          ], ["auxiliary", "辅助素材"], ["unindexed", "未入索引"], ["labeled", "已标记"]] as Array<[Filter, string]>).map(([value, label]) => <button type="button" className={filter === value ? "is-active" : ""} key={value} onClick={() => setFilter(value)}>{label}</button>)}
        </div>
        <label className="media-library-actor"><span>操作者</span><input value={actor} onChange={(event) => setActor(event.target.value)} onBlur={() => actor.trim() && saveActor(actor)} placeholder="保存时必填" /></label>
      </div>

      <div className="media-library-layout">
        <div className="media-library-list" role="list">
          {visible.map((item) => {
            const role = roleFor(item, roles);
            const auxiliary = isAuxiliary(role);
            return (
              <button type="button" className={`media-library-row ${selectedId === item.media_id ? "is-selected" : ""}`} key={item.media_id} onClick={() => select(item)}>
                <span className="media-library-camera">{role.camera_override || item.inferred_camera || "—"}</span>
                <span className="media-library-name"><strong>{item.display_name}</strong><small>{item.folder_label || "素材"}</small></span>
                <span className="media-library-role"><strong>{ROLE_LABELS[role.source_role || "sync_camera"] || role.role_label || role.source_role || "同步机位"}</strong><small>{role.scene_id ? `场 ${role.scene_id}` : auxiliary ? "不作为同步主机位" : ""}</small></span>
                <em className={item.indexed ? "is-indexed" : "is-unindexed"}>{item.indexed ? "已入索引" : "未入索引"}</em>
              </button>
            );
          })}
          {filtered.length > visible.length ? <p className="production-note">当前显示前 {visible.length} 条；继续缩小搜索范围以定位其它素材。</p> : null}
          {!visible.length ? <p className="empty-copy">当前筛选下没有素材。</p> : null}
        </div>

        <aside className="media-role-inspector">
          {selectedItem ? (
            <>
              <div className="media-role-inspector-head"><div><p className="eyebrow">人工制作事实</p><h3>{selectedItem.display_name}</h3></div><span>{selectedItem.indexed ? "已入索引" : "未入索引"}</span></div>
              <p className="production-note">原识别机位：{selectedItem.inferred_camera || "—"} · {selectedItem.folder_label || "素材"}</p>
              <label className="production-field"><span>机位覆盖</span><input value={draft.camera_override || ""} onChange={(event) => patch({ camera_override: event.target.value })} placeholder={`默认 ${selectedItem.inferred_camera || "—"}`} /></label>
              <label className="production-field"><span>素材角色</span><select value={draft.source_role || "sync_camera"} onChange={(event) => changeSourceRole(event.target.value)}><option value="sync_camera">同步机位</option><option value="aerial">航拍</option><option value="broll">空镜 / B-roll</option><option value="gopro">GoPro</option><option value="insert">细节 / Insert</option><option value="custom">自定义</option></select></label>
              <label className="production-field"><span>同步策略</span><select value={draft.sync_policy || "auto"} onChange={(event) => patch({ sync_policy: event.target.value })}><option value="auto">参与同步</option><option value="exclude">不参与同步</option></select></label>
              <label className="production-field"><span>场景归属</span><input value={draft.scene_id || ""} onChange={(event) => patch({ scene_id: event.target.value })} placeholder="例如 12-3" /></label>
              <label className="production-field"><span>自定义标签</span><input value={draft.role_label || ""} onChange={(event) => patch({ role_label: event.target.value })} placeholder="例如 城市建立镜头" /></label>
              <label className="production-field"><span>备注</span><textarea rows={5} value={draft.note || ""} onChange={(event) => patch({ note: event.target.value })} placeholder="场记或剪辑用途，例如：饭店外景建立镜头，开场和转场可用" /></label>
              <button type="button" disabled={busy || !actor.trim()} onClick={() => void save()}>保存素材角色</button>
              <p className="production-note">航拍、空镜、GoPro、Insert 可没有时间码或可用音频；设为“不参与同步”后只从同步主机位池排除，仍可进入 Coverage / 粗剪辅助素材池。它不是 Editorial Best。</p>
            </>
          ) : <p className="empty-copy">选择一条素材查看制作属性。</p>}
        </aside>
      </div>

      <div className="media-binding-disclosure">
        <button type="button" className="secondary" onClick={() => setShowBinding((current) => !current)}>{showBinding ? "收起本机素材恢复" : "本机素材缺失或换盘？打开素材恢复"}</button>
        {showBinding ? <MediaBindingWorkbench baseUrl={baseUrl} projectId={projectId} /> : null}
      </div>
    </section>
  );
}
