import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useEffect, useMemo, useState } from "react";
import { DesktopClient, type MediaBindingSummary } from "../../api/desktop";
import { HostConnectionError } from "../../api/host";
import { PlatformClient } from "../../api/platform";

interface Props {
  baseUrl: string;
  projectId: string;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function splitRoots(text: string): string[] {
  return [...new Set(text.split(/\r?\n/).map((value) => value.trim()).filter(Boolean))];
}

export function MediaBindingWorkbench({ baseUrl, projectId }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const platform = useMemo(() => new PlatformClient(), []);
  const [summary, setSummary] = useState<MediaBindingSummary | null>(null);
  const [rootsText, setRootsText] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("正在读取本机素材绑定…");

  async function reload(): Promise<void> {
    try {
      const payload = await client.mediaBinding(projectId);
      setSummary(payload.summary);
      setRootsText(payload.summary.roots.join("\n"));
      setMessage(`media_binding.v1 · ${payload.summary.resolved}/${payload.summary.total} 已解析`);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  useEffect(() => {
    void reload();
    // client is stable for baseUrl.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, projectId]);

  async function chooseRoots(): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览无法打开系统目录选择器；可以在下方手动填写目录。 ");
      return;
    }
    try {
      const selected = await openDialog({
        directory: true,
        multiple: true,
        title: "选择本机素材目录",
      });
      const values = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
      if (!values.length) return;
      const merged = [...new Set([...splitRoots(rootsText), ...values])];
      setRootsText(merged.join("\n"));
      setMessage(`已选择 ${values.length} 个本机素材目录；尚未写入绑定。`);
    } catch (error) {
      setMessage(`目录选择失败：${errorMessage(error)}`);
    }
  }

  async function scan(replace: boolean): Promise<void> {
    const roots = splitRoots(rootsText);
    if (!roots.length) {
      setMessage("至少填写或选择一个本机素材目录。");
      return;
    }
    setBusy(true);
    setMessage(replace ? "正在替换本机 roots 并重新绑定…" : "正在扫描并追加本机绑定…");
    try {
      const payload = await client.scanMediaBinding(projectId, roots, replace);
      setSummary(payload.summary);
      setRootsText(payload.summary.roots.join("\n"));
      const scanText = payload.summary.scan
        ? ` · 扫描 ${payload.summary.scan.files_seen} 文件 · verified ${payload.summary.scan.verified_matches} · name ${payload.summary.scan.provisional_name_matches}`
        : "";
      setMessage(`绑定完成 · ${payload.summary.resolved}/${payload.summary.total} 已解析${scanText}`);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function reveal(path: string): Promise<void> {
    if (!isTauri()) return;
    try {
      await platform.reveal(path);
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  const items = useMemo(
    () => [...(summary?.items ?? [])].sort((left, right) => Number(left.local_exists) - Number(right.local_exists) || left.name.localeCompare(right.name)),
    [summary],
  );

  return (
    <section className="phase3-workbench media-binding-workbench">
      <header className="production-heading">
        <div>
          <p className="eyebrow">Phase 7 · Device-local Media Binding</p>
          <h2>本机素材</h2>
        </div>
        <span className="production-state">{message}</span>
      </header>

      <div className="production-grid media-binding-grid">
        <div className="production-panel">
          <div className="media-binding-counts">
            <strong>{summary?.resolved ?? 0}<small>已解析</small></strong>
            <strong>{summary?.missing ?? 0}<small>缺失</small></strong>
            <strong>{summary?.total ?? 0}<small>媒体身份</small></strong>
          </div>
          <label className="production-field">
            <span>本机素材 roots · 每行一个目录</span>
            <textarea
              className="media-roots-input"
              rows={6}
              value={rootsText}
              onChange={(event) => setRootsText(event.target.value)}
              spellCheck={false}
              placeholder="/Volumes/PROJECT/Media"
            />
          </label>
          <div className="production-actions media-binding-actions">
            <button type="button" className="secondary" disabled={busy || !isTauri()} onClick={() => void chooseRoots()}>选择目录</button>
            <button type="button" className="secondary" disabled={busy} onClick={() => void scan(false)}>追加并扫描</button>
            <button type="button" disabled={busy} onClick={() => void scan(true)}>替换 roots 并重绑</button>
          </div>
          <p className="production-note">
            绑定写入当前设备的 <code>media-bindings.json</code>，不会修改共享 workspace 或 Review authority。verified 内容身份优先，旧工程才使用唯一文件名回退。
          </p>
          {summary?.state_path ? (
            <button type="button" className="secondary media-state-path" disabled={!isTauri()} onClick={() => void reveal(summary.state_path)}>
              定位设备绑定文件
            </button>
          ) : null}
        </div>

        <div className="production-panel media-binding-list-panel">
          <div className="parse-heading">
            <div>
              <p className="eyebrow">Binding inventory</p>
              <strong>{summary?.device_name || "当前设备"}</strong>
            </div>
            {summary?.pending_analysis ? <span>等待首次 analysis 建立 clip identity</span> : null}
          </div>
          <div className="media-binding-list">
            {items.length ? items.slice(0, 300).map((item) => (
              <article className={`media-binding-row ${item.local_exists ? "is-resolved" : "is-missing"}`} key={item.media_id}>
                <div>
                  <strong>{item.name || item.media_id}</strong>
                  <span>{item.verified ? "verified media_id" : "provisional media_id"} · {item.clip_ids.length} clips</span>
                </div>
                <em>{item.local_exists ? "resolved" : "missing"}</em>
                <code>{item.resolved_path || item.source_media_path || item.media_id}</code>
                {item.local_exists && item.resolved_path ? (
                  <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void reveal(item.resolved_path)}>Finder / Explorer</button>
                ) : null}
              </article>
            )) : <p className="empty-copy">当前项目还没有可枚举的媒体身份；媒体目录项目在首次 analysis 前会显示 root 扫描结果。</p>}
          </div>
        </div>
      </div>
    </section>
  );
}
