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

function errorMessage(error: unknown): string {
  if (error instanceof HostConnectionError) return error.message;
  return error instanceof Error ? error.message : String(error);
}

function rootsFromText(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

export function ProjectLifecyclePanel({ baseUrl, selectedProject, onWorkspaceChanged }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [inputKind, setInputKind] = useState<"fcpxml" | "media-directory">("fcpxml");
  const [scriptPath, setScriptPath] = useState("");
  const [fcpxmlPath, setFcpxmlPath] = useState("");
  const [mediaRoots, setMediaRoots] = useState("");
  const [prepareAfterCreate, setPrepareAfterCreate] = useState(true);
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [message, setMessage] = useState("项目生命周期由 Python WorkspaceRegistry 管理。 ");
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
      setMessage("浏览器预览不提供原生文件选择；可以手动填写路径。");
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
      setMessage("浏览器预览不提供原生目录选择；可以手动填写路径。");
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
    setMessage("正在执行 Python project preflight…");
    try {
      const next = await client.preflightProject(payload());
      setPreflight(next);
      setMessage(next.ready ? "项目预检通过。" : `项目预检未通过：${next.errors.join("；")}`);
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
        setMessage(`项目预检未通过：${checked.errors.join("；")}`);
        return;
      }
      setMessage("正在由 Python WorkspaceRegistry 创建项目…");
      const created = await client.createProject(payload());
      if (prepareAfterCreate) {
        try {
          const task = await client.prepareProject(created.project_id);
          setMessage(`项目已创建 · prepare task ${task.task_id ?? "submitted"}`);
        } catch (error) {
          setMessage(`项目已创建，但 prepare task 提交失败：${errorMessage(error)}`);
        }
      } else {
        setMessage("项目已创建；尚未启动 prepare task。");
      }
      setName("");
      setScriptPath("");
      setFcpxmlPath("");
      setMediaRoots("");
      setPreflight(null);
      await onWorkspaceChanged(created.project_id);
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  async function removeSelected(): Promise<void> {
    if (!selectedProject || deleteConfirm.trim() !== selectedProject.project_id) {
      setMessage("删除前必须完整输入当前 project_id。 ");
      return;
    }
    setBusy(true);
    setMessage(`正在删除 ${selectedProject.project_id}…`);
    try {
      await client.deleteProject(selectedProject.project_id);
      setDeleteConfirm("");
      setMessage("项目已由 Python WorkspaceRegistry 安全删除。");
      await onWorkspaceChanged();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="project-lifecycle-panel">
      <button type="button" className="secondary lifecycle-toggle" onClick={() => setOpen((value) => !value)}>
        {open ? "收起项目管理" : "新建 / 删除项目"}
      </button>
      {open ? (
        <div className="project-lifecycle-body">
          <p className="project-lifecycle-message">{message}</p>
          <div className="lifecycle-kind">
            <button type="button" className={inputKind === "fcpxml" ? "is-active" : ""} onClick={() => { setInputKind("fcpxml"); setPreflight(null); }}>FCPXML</button>
            <button type="button" className={inputKind === "media-directory" ? "is-active" : ""} onClick={() => { setInputKind("media-directory"); setPreflight(null); }}>媒体目录</button>
          </div>
          <label>
            <span>项目名称</span>
            <input value={name} onChange={(event) => { setName(event.target.value); setPreflight(null); }} placeholder="短剧 A组" />
          </label>
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
              <span>媒体目录 · 每行一个</span>
              <textarea rows={4} value={mediaRoots} onChange={(event) => { setMediaRoots(event.target.value); setPreflight(null); }} spellCheck={false} />
              <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void chooseMediaRoots()}>选择目录</button>
            </label>
          )}
          <label className="lifecycle-checkbox">
            <input type="checkbox" checked={prepareAfterCreate} onChange={(event) => setPrepareAfterCreate(event.target.checked)} />
            <span>创建后提交 prepare_project</span>
          </label>
          {preflight ? (
            <div className={`lifecycle-preflight ${preflight.ready ? "is-ready" : "is-error"}`}>
              <strong>{preflight.ready ? "Preflight ready" : "Preflight blocked"}</strong>
              {preflight.errors.map((error) => <span key={error}>{error}</span>)}
              {preflight.warnings.map((warning) => <span key={warning}>⚠ {warning}</span>)}
            </div>
          ) : null}
          <div className="lifecycle-actions">
            <button type="button" className="secondary" disabled={busy} onClick={() => void runPreflight()}>预检</button>
            <button type="button" disabled={busy} onClick={() => void create()}>创建项目</button>
          </div>

          {selectedProject ? (
            <div className="lifecycle-delete">
              <p>删除只允许当前 workspace 的 generated project，并由 Core 先移入 quarantine 再更新 registry。</p>
              <input value={deleteConfirm} onChange={(event) => setDeleteConfirm(event.target.value)} placeholder={`输入 ${selectedProject.project_id}`} />
              <button type="button" className="danger-quiet" disabled={busy || deleteConfirm.trim() !== selectedProject.project_id} onClick={() => void removeSelected()}>删除选中项目</button>
            </div>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
