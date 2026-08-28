import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { useMemo, useState } from "react";
import {
  DesktopClient,
  type ProjectCreatePayload,
  type ProjectPreflight,
} from "../../api/desktop";
import { HostConnectionError, type ProjectSummary } from "../../api/host";

interface Props {
  baseUrl: string;
  selectedProject: ProjectSummary | null;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
}

type LifecycleMode = "create" | "manage" | null;

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function rootsFromText(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

export function ProjectLifecyclePanel({ baseUrl, selectedProject, onWorkspaceChanged }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [mode, setMode] = useState<LifecycleMode>(null);
  const [name, setName] = useState("");
  const [inputKind, setInputKind] = useState<"fcpxml" | "media-directory">("fcpxml");
  const [scriptPath, setScriptPath] = useState("");
  const [fcpxmlPath, setFcpxmlPath] = useState("");
  const [mediaRoots, setMediaRoots] = useState("");
  const [prepareAfterCreate, setPrepareAfterCreate] = useState(true);
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [message, setMessage] = useState("选择剧本和素材来源，镜序会先检查项目是否可以安全创建。");
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
      const selected = await openDialog({ directory: true, multiple: true, title: "选择媒体目录" });
      const values = Array.isArray(selected) ? selected : typeof selected === "string" ? [selected] : [];
      if (!values.length) return;
      setMediaRoots([...new Set([...rootsFromText(mediaRoots), ...values])].join("\n"));
      setPreflight(null);
    } catch (error) {
      setMessage(`目录选择失败：${errorMessage(error)}`);
    }
  }

  async function runPreflight(): Promise<ProjectPreflight | null> {
    setBusy(true);
    setMessage("正在检查剧本与素材来源…");
    try {
      const next = await client.preflightProject(payload());
      setPreflight(next);
      setMessage(next.ready ? "检查通过，可以创建项目。" : `还不能创建：${next.errors.join("；")}`);
      return next;
    } catch (error) {
      setMessage(errorMessage(error));
      return null;
    } finally {
      setBusy(false);
    }
  }

  async function create(): Promise<void> {
    setBusy(true);
    try {
      const checked = await client.preflightProject(payload());
      setPreflight(checked);
      if (!checked.ready) {
        setMessage(`还不能创建：${checked.errors.join("；")}`);
        return;
      }
      setMessage("正在创建项目…");
      const created = await client.createProject(payload());
      if (prepareAfterCreate) {
        try {
          await client.prepareProject(created.project_id);
          setMessage("项目已创建，正在后台整理素材与剧本。");
        } catch (error) {
          setMessage(`项目已创建，但后台整理没有启动：${errorMessage(error)}`);
        }
      } else {
        setMessage("项目已创建。");
      }
      setName("");
      setScriptPath("");
      setFcpxmlPath("");
      setMediaRoots("");
      setPreflight(null);
      await onWorkspaceChanged(created.project_id);
      setMode(null);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selectedProject || deleteConfirm.trim() !== selectedProject.project_id) {
      setMessage("移除前必须完整输入当前项目 ID。");
      return;
    }
    setBusy(true);
    setMessage(`正在移除 ${selectedProject.name || selectedProject.project_id}…`);
    try {
      await client.deleteProject(selectedProject.project_id);
      setDeleteConfirm("");
      setMessage("项目已移除。");
      await onWorkspaceChanged();
      setMode(null);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  const createMode = mode === "create";
  const manageMode = mode === "manage" && selectedProject;

  return (
    <>
      <div className="project-library-heading-actions">
        <button type="button" className="project-new-button" onClick={() => setMode("create")}>新建</button>
        {selectedProject ? <button type="button" className="project-manage-button" aria-label="项目管理" title="项目管理" onClick={() => setMode("manage")}>•••</button> : null}
      </div>

      {mode ? (
        <div className="project-lifecycle-overlay" role="presentation" onMouseDown={() => !busy && setMode(null)}>
          <section className="project-lifecycle-dialog" role="dialog" aria-modal="true" aria-label={createMode ? "新建项目" : "项目管理"} onMouseDown={(event) => event.stopPropagation()}>
            <header className="project-lifecycle-header">
              <div>
                <p className="eyebrow">Production</p>
                <h2>{createMode ? "新建项目" : selectedProject?.name || "项目管理"}</h2>
              </div>
              <button type="button" className="dialog-close" disabled={busy} onClick={() => setMode(null)}>关闭</button>
            </header>

            {createMode ? (
              <div className="project-lifecycle-body">
                <p className="project-lifecycle-message">{message}</p>
                <div className="lifecycle-kind">
                  <button type="button" className={inputKind === "fcpxml" ? "is-active" : ""} onClick={() => { setInputKind("fcpxml"); setPreflight(null); }}>已有 FCPXML</button>
                  <button type="button" className={inputKind === "media-directory" ? "is-active" : ""} onClick={() => { setInputKind("media-directory"); setPreflight(null); }}>素材目录</button>
                </div>
                <label><span>项目名称</span><input value={name} onChange={(event) => { setName(event.target.value); setPreflight(null); }} placeholder="例如：人不狠，站不稳" /></label>
                <label>
                  <span>剧本</span>
                  <div className="lifecycle-path-row">
                    <input value={scriptPath} onChange={(event) => { setScriptPath(event.target.value); setPreflight(null); }} spellCheck={false} />
                    <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void chooseFile("script")}>选择</button>
                  </div>
                </label>
                {inputKind === "fcpxml" ? (
                  <label>
                    <span>FCPXML</span>
                    <div className="lifecycle-path-row">
                      <input value={fcpxmlPath} onChange={(event) => { setFcpxmlPath(event.target.value); setPreflight(null); }} spellCheck={false} />
                      <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void chooseFile("fcpxml")}>选择</button>
                    </div>
                  </label>
                ) : (
                  <label>
                    <span>素材目录</span>
                    <textarea rows={4} value={mediaRoots} onChange={(event) => { setMediaRoots(event.target.value); setPreflight(null); }} spellCheck={false} />
                    <button type="button" className="secondary choose-roots" disabled={!isTauri()} onClick={() => void chooseMediaRoots()}>选择目录</button>
                  </label>
                )}
                <label className="lifecycle-checkbox">
                  <input type="checkbox" checked={prepareAfterCreate} onChange={(event) => setPrepareAfterCreate(event.target.checked)} />
                  <span>创建后在后台自动整理素材、转写并匹配剧本</span>
                </label>
                {preflight ? (
                  <div className={`lifecycle-preflight ${preflight.ready ? "is-ready" : "is-error"}`}>
                    <strong>{preflight.ready ? "可以创建" : "需要处理"}</strong>
                    {preflight.errors.map((error) => <span key={error}>{error}</span>)}
                    {preflight.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                  </div>
                ) : null}
                <div className="lifecycle-actions">
                  <button type="button" className="secondary" disabled={busy} onClick={() => void runPreflight()}>检查</button>
                  <button type="button" disabled={busy} onClick={() => void create()}>创建项目</button>
                </div>
              </div>
            ) : manageMode ? (
              <div className="project-lifecycle-body project-manage-body">
                <div className="project-manage-summary">
                  <span>项目 ID</span>
                  <code>{selectedProject.project_id}</code>
                  <span>来源</span>
                  <strong>{selectedProject.input_kind === "media-directory" ? "素材目录" : "FCPXML"}</strong>
                </div>
                <div className="lifecycle-delete">
                  <strong>移除项目</strong>
                  <p>这是低频危险操作。输入项目 ID 确认；Core 会按现有隔离与 quarantine 规则处理项目数据。</p>
                  <input value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder={selectedProject.project_id} />
                  <button type="button" className="danger-quiet" disabled={busy || deleteConfirm.trim() !== selectedProject.project_id} onClick={() => void removeSelected()}>移除当前项目</button>
                </div>
                <p className="project-lifecycle-message">{message}</p>
              </div>
            ) : null}
          </section>
        </div>
      ) : null}
    </>
  );
}
