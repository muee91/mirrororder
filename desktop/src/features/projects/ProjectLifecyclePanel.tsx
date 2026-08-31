import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import {
  DesktopClient,
  type ProjectCreatePayload,
  type ProjectPreflight,
} from "../../api/desktop";
import { HostConnectionError } from "../../api/host";

interface Props {
  baseUrl: string;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function rootsFromText(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

export function ProjectLifecyclePanel({ baseUrl, onWorkspaceChanged }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [inputKind, setInputKind] = useState<"fcpxml" | "media-directory">("fcpxml");
  const [scriptPath, setScriptPath] = useState("");
  const [fcpxmlPath, setFcpxmlPath] = useState("");
  const [mediaRoots, setMediaRoots] = useState("");
  const [prepareAfterCreate, setPrepareAfterCreate] = useState(true);
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [message, setMessage] = useState("选择剧本和素材来源；创建时会自动检查配置。");
  const [busy, setBusy] = useState(false);

  function payload(): ProjectCreatePayload {
    return {
      name: name.trim(),
      input_kind: inputKind,
      script: scriptPath.trim(),
      fcpxml: inputKind === "fcpxml" ? fcpxmlPath.trim() : undefined,
      media_roots: inputKind === "media-directory" ? rootsFromText(mediaRoots) : undefined,
      timeline_mode: "sequential",
    };
  }

  function reset(): void {
    setName("");
    setScriptPath("");
    setFcpxmlPath("");
    setMediaRoots("");
    setPreflight(null);
    setMessage("选择剧本和素材来源；创建时会自动检查配置。");
  }

  async function chooseFile(kind: "script" | "fcpxml"): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不提供系统文件选择器；可以手动填写路径。");
      return;
    }
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: kind === "script" ? "选择剧本" : "选择 FCPXML",
        filters: kind === "script"
          ? [{ name: "剧本", extensions: ["docx", "txt", "md", "markdown"] }]
          : [{ name: "Final Cut Pro XML", extensions: ["fcpxml", "fcpxmld"] }],
      });
      if (typeof selected !== "string" || !selected.trim()) return;
      if (kind === "script") setScriptPath(selected);
      else setFcpxmlPath(selected);
      setPreflight(null);
    } catch (error) {
      setMessage(`文件选择失败：${errorMessage(error)}`);
    }
  }

  async function chooseMediaRoots(): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不提供系统目录选择器；可以手动填写路径。");
      return;
    }
    try {
      const selected = await openDialog({ directory: true, multiple: true, title: "选择素材目录" });
      const values = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
      if (!values.length) return;
      setMediaRoots([...new Set([...rootsFromText(mediaRoots), ...values])].join("\n"));
      setPreflight(null);
    } catch (error) {
      setMessage(`目录选择失败：${errorMessage(error)}`);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    setMessage("正在检查项目来源…");
    try {
      const checked = await client.preflightProject(payload());
      setPreflight(checked);
      if (!checked.ready) {
        setMessage("还有项目来源需要处理。");
        return;
      }
      setMessage("正在创建项目…");
      const created = await client.createProject(payload());
      if (prepareAfterCreate) {
        try {
          await client.prepareProject(created.project_id);
          setMessage("项目已创建，后台整理已开始。");
        } catch (error) {
          setMessage(`项目已创建，但后台整理没有启动：${errorMessage(error)}`);
        }
      } else {
        setMessage("项目已创建。");
      }
      await onWorkspaceChanged(created.project_id);
      reset();
      setOpen(false);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const sourceReady = inputKind === "fcpxml" ? Boolean(fcpxmlPath.trim()) : rootsFromText(mediaRoots).length > 0;
  const canCreate = Boolean(name.trim() && scriptPath.trim() && sourceReady);

  return (
    <>
      <button type="button" className="project-new-button project-home-new-button" onClick={() => setOpen(true)}>新建项目</button>

      {open ? (
        <div className="project-lifecycle-overlay" role="presentation" onMouseDown={() => !busy && setOpen(false)}>
          <section className="project-lifecycle-dialog" role="dialog" aria-modal="true" aria-label="新建项目" onMouseDown={(event) => event.stopPropagation()}>
            <header className="project-lifecycle-header">
              <div>
                <p className="eyebrow">项目</p>
                <h2>新建项目</h2>
                <span>从现有 FCPXML 或原始素材目录开始。</span>
              </div>
              <button type="button" className="dialog-close" disabled={busy} onClick={() => setOpen(false)}>关闭</button>
            </header>

            <div className="project-lifecycle-body">
              <div className="lifecycle-kind" aria-label="项目来源">
                <button type="button" className={inputKind === "fcpxml" ? "is-active" : ""} onClick={() => { setInputKind("fcpxml"); setPreflight(null); }}>已有 FCPXML</button>
                <button type="button" className={inputKind === "media-directory" ? "is-active" : ""} onClick={() => { setInputKind("media-directory"); setPreflight(null); }}>原始素材</button>
              </div>

              <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setPreflight(null); }} placeholder="输入项目名称" /></label>

              <label>
                <span>剧本</span>
                <div className="lifecycle-path-row">
                  <input value={scriptPath} onChange={(event) => { setScriptPath(event.target.value); setPreflight(null); }} spellCheck={false} placeholder="选择剧本文件" />
                  <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void chooseFile("script")}>选择…</button>
                </div>
              </label>

              {inputKind === "fcpxml" ? (
                <label>
                  <span>FCPXML</span>
                  <div className="lifecycle-path-row">
                    <input value={fcpxmlPath} onChange={(event) => { setFcpxmlPath(event.target.value); setPreflight(null); }} spellCheck={false} placeholder="选择 FCPXML 文件" />
                    <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void chooseFile("fcpxml")}>选择…</button>
                  </div>
                </label>
              ) : (
                <label>
                  <span>素材目录</span>
                  <textarea rows={3} value={mediaRoots} onChange={(event) => { setMediaRoots(event.target.value); setPreflight(null); }} spellCheck={false} placeholder="每行一个素材目录" />
                  <button type="button" className="secondary choose-roots" disabled={!isTauri()} onClick={() => void chooseMediaRoots()}>选择目录…</button>
                </label>
              )}

              <label className="lifecycle-checkbox">
                <input type="checkbox" checked={prepareAfterCreate} onChange={(event) => setPrepareAfterCreate(event.target.checked)} />
                <span><strong>创建后自动整理</strong><small>后台整理素材、转写并匹配剧本；进度在状态中心查看。</small></span>
              </label>

              {preflight && !preflight.ready ? (
                <div className="lifecycle-preflight is-error" role="alert">
                  <strong>还不能创建</strong>
                  {preflight.errors.map((error) => <span key={error}>{error}</span>)}
                  {preflight.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              ) : null}

              <p className="project-lifecycle-message" aria-live="polite">{message}</p>
              <div className="lifecycle-actions">
                <button type="button" className="secondary" disabled={busy} onClick={() => setOpen(false)}>取消</button>
                <button type="button" disabled={busy || !canCreate} onClick={() => void create()}>{prepareAfterCreate ? "创建并整理" : "创建项目"}</button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
