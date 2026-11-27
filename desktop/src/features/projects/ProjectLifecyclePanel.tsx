import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { PlatformClient } from "../../api/platform";
import { useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { rememberSyncSubmissionIssue } from "../../app/resumeState";
import {
  DesktopClient,
  type ProjectCreatePayload,
  type ProjectPreflight,
} from "../../api/desktop";
import { HostConnectionError, errorMessage } from "../../api/host";
import { ProjectActionClient } from "../../api/projectActions";
import { DeviceTaskClient } from "../../api/tasks";

interface Props {
  baseUrl: string;
  workspaceId?: string;
  onOpenExistingFolder?: () => void;
  onWorkspaceChanged: (preferredProjectId?: string) => Promise<void>;
  onStatusMessage?: (message: string) => void;
}

const IMPORT_POLL_MS = 750;
const IMPORT_POLL_LIMIT = 120;

function FileField({ label, value, placeholder, required, onChange, onChoose }: {
  label: string;
  value: string;
  placeholder: string;
  required?: boolean;
  onChange: (path: string) => void;
  onChoose: () => void;
}) {
  const id = useId();
  return <div className="lifecycle-field">
    <label htmlFor={id}>{label}</label>
    <div className="lifecycle-path-row">
      <input id={id} value={value} required={required} onChange={(event) => onChange(event.target.value)} spellCheck={false} placeholder={placeholder} />
      {isTauri() && <button type="button" className="secondary" aria-label={`选择${label}文件`} onClick={onChoose}>选择文件…</button>}
    </div>
  </div>;
}

function rootsFromText(value: string): string[] {
  return [...new Set(value.split(/\r?\n/).map((item) => item.trim()).filter(Boolean))];
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, ms));
}

export function ProjectLifecyclePanel({ baseUrl, workspaceId = baseUrl, onOpenExistingFolder, onWorkspaceChanged, onStatusMessage }: Props) {
  const client = useMemo(() => new DesktopClient(baseUrl), [baseUrl]);
  const projectActions = useMemo(() => new ProjectActionClient(baseUrl), [baseUrl]);
  const deviceTasks = useMemo(() => new DeviceTaskClient(baseUrl), [baseUrl]);
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [inputKind, setInputKind] = useState<"fcpxml" | "media-directory">("media-directory");
  const [scriptPath, setScriptPath] = useState("");
  const [slatePath, setSlatePath] = useState("");
  const [fcpxmlPath, setFcpxmlPath] = useState("");
  const [mediaRoots, setMediaRoots] = useState("");
  const [prepareAfterCreate, setPrepareAfterCreate] = useState(true);
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState("");
  const [acceptedWarnings, setAcceptedWarnings] = useState("");
  const inFlight = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const rootsId = useId();
  const feedbackId = useId();
  const [importBusy, setImportBusy] = useState(false);
  const [importState, setImportState] = useState<"idle" | "submitted" | "done" | "attention">("idle");

  function payload(): ProjectCreatePayload {
    return {
      name: name.trim(),
      input_kind: inputKind,
      script: scriptPath.trim() || undefined,
      slate: slatePath.trim() || undefined,
      fcpxml: inputKind === "fcpxml" ? fcpxmlPath.trim() : undefined,
      media_roots: inputKind === "media-directory" ? rootsFromText(mediaRoots) : undefined,
      timeline_mode: "sequential",
    };
  }

  function reset(): void {
    setName("");
    setScriptPath("");
    setSlatePath("");
    setFcpxmlPath("");
    setMediaRoots("");
    setCreatedId("");
    setAcceptedWarnings("");
    setInputKind("media-directory");
    setPrepareAfterCreate(true);
    setPreflight(null);
    setMessage("");
  }

  function clearFeedback(): void {
    setMessage("");
    setPreflight(null);
    setAcceptedWarnings("");
  }

  async function chooseFile(kind: "script" | "fcpxml" | "slate"): Promise<void> {
    if (!isTauri()) {
      setMessage("浏览器预览不提供系统文件选择器；可以手动填写路径。");
      return;
    }
    try {
      const selected = await openDialog({
        directory: false,
        multiple: false,
        title: kind === "script" ? "选择剧本" : kind === "fcpxml" ? "选择 FCPXML" : "选择现场场记（PDF / 照片）",
        filters: kind === "script"
          ? [{ name: "剧本", extensions: ["docx", "txt", "md", "markdown"] }]
          : kind === "fcpxml"
            ? [{ name: "Final Cut Pro XML", extensions: ["fcpxml", "fcpxmld"] }]
            : [{ name: "场记 PDF 或照片", extensions: ["pdf", "jpg", "jpeg", "png", "webp"] }],
      });
      if (typeof selected !== "string" || !selected.trim()) return;
      if (kind === "script") setScriptPath(selected);
      else if (kind === "fcpxml") setFcpxmlPath(selected);
      else setSlatePath(selected);
      clearFeedback();
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
      clearFeedback();
    } catch (error) {
      setMessage(`目录选择失败：${errorMessage(error)}`);
    }
  }

  async function waitForImportedProject(taskId: string, projectId: string): Promise<void> {
    for (let attempt = 0; attempt < IMPORT_POLL_LIMIT; attempt += 1) {
      await delay(IMPORT_POLL_MS);
      const task = (await deviceTasks.list()).find((item) => item.task_id === taskId);
      if (!task) continue;
      if (task.status === "completed") {
        await onWorkspaceChanged(projectId);
        setImportState("done");
        onStatusMessage?.(`项目已导入 · ${projectId}`);
        return;
      }
      if (["failed", "cancelled", "interrupted"].includes(task.status)) {
        throw new HostConnectionError(task.error || task.message || "项目导入没有完成");
      }
    }
    setImportState("submitted");
    onStatusMessage?.("项目仍在后台导入；可在状态中心查看，完成后刷新项目。");
  }

  async function importProject(): Promise<void> {
    if (!isTauri()) {
      setImportState("attention");
      onStatusMessage?.("打开外部项目只能从桌面 App 执行。");
      return;
    }
    setImportBusy(true);
    setImportState("idle");
    try {
      const { os } = await new PlatformClient().info();
      // Finder exposes a registered directory package as a document on macOS.
      // Other desktops continue to pick the physical .mirrorproj directory.
      const selected = await openDialog({
        directory: os !== "macos",
        multiple: false,
        title: "打开镜序项目 (.mirrorproj)",
        ...(os === "macos" ? { filters: [{ name: "镜序工程", extensions: ["mirrorproj"] }] } : {}),
      });
      if (typeof selected !== "string" || !selected.trim()) return;
      const submission = await projectActions.importPackage(selected);
      setImportState("submitted");
      onStatusMessage?.(`已提交“${submission.package.name || submission.package.project_id}”导入任务；进度在状态中心查看。`);
      const taskId = String(submission.task.task_id || "").trim();
      if (taskId) await waitForImportedProject(taskId, submission.package.project_id);
    } catch (error) {
      setImportState("attention");
      const detail = `项目导入需要处理：${errorMessage(error)}`;
      setMessage(detail);
      onStatusMessage?.(detail);
    } finally {
      setImportBusy(false);
    }
  }

  function close(): void {
    if (inFlight.current) return;
    if (createdId) reset();
    setOpen(false);
    trigger.current?.focus();
  }

  function dialogKeys(event: KeyboardEvent<HTMLElement>): void {
    if (event.nativeEvent.isComposing) return;
    if (event.key === "Escape") {
      event.preventDefault();
      close();
    }
    if (event.key !== "Tab") return;
    const controls = [...event.currentTarget.querySelectorAll<HTMLElement>(
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), summary",
    )].filter((control) => control.getClientRects().length > 0);
    const edge = event.shiftKey ? controls[0] : controls.at(-1);
    if (document.activeElement === edge) {
      event.preventDefault();
      (event.shiftKey ? controls.at(-1) : controls[0])?.focus();
    }
  }

  async function create(): Promise<void> {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(true);
    let savedId = createdId;
    try {
      if (!savedId) {
        const values = payload();
        setMessage("正在检查项目来源…");
        const checked = await client.preflightProject(values);
        setPreflight(checked);
        if (!checked.ready) {
          setAcceptedWarnings("");
          setMessage("");
          return;
        }
        const warningKey = JSON.stringify([values, checked.warnings]);
        if (checked.warnings.length && warningKey !== acceptedWarnings) {
          setAcceptedWarnings(warningKey);
          setMessage("");
          return;
        }
        setMessage("正在创建项目…");
        const created = await client.createProject(values);
        savedId = created.project_id;
        setCreatedId(savedId);

        if (prepareAfterCreate) {
          try {
            // Sync first, always. Script transcription/matching is queued by
            // the backend as a separate task so a long ASR run never keeps
            // the sync master locked in "running".
            if (inputKind === "media-directory") {
              await client.multicamSync(savedId);
              rememberSyncSubmissionIssue(workspaceId, savedId, "");
            } else {
              await client.prepareProject(savedId);
            }
          } catch (error) {
            const detail = errorMessage(error);
            if (inputKind === "media-directory") rememberSyncSubmissionIssue(workspaceId, savedId, detail);
            onStatusMessage?.(`项目已创建，后台任务提交未确认。 ${detail}`);
          }
        }
      }
      setMessage("正在打开已保存的项目…");
      await onWorkspaceChanged(savedId);
      reset();
      setOpen(false);
    } catch (error) {
      setMessage(savedId
        ? `项目已保存，打开失败。 ${errorMessage(error)}`
        : errorMessage(error));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  }

  const raw = inputKind === "media-directory";
  const missing = [
    !name.trim() && "项目名称",
    (raw ? !rootsFromText(mediaRoots).length : !fcpxmlPath.trim()) && (raw ? "素材目录" : "FCPXML 文件"),
    !raw && !scriptPath.trim() && "剧本",
  ].filter(Boolean);
  const canCreate = Boolean(createdId) || missing.length === 0;
  const feedback = message || (!canCreate ? `还需填写${missing.join("、")}` : "");
  const scriptField = <FileField label={raw ? "剧本" : "剧本（必填）"} value={scriptPath} placeholder="选择剧本文件"
    required={!raw} onChange={setScriptPath} onChoose={() => void chooseFile("script")} />;
  const importLabel = importBusy
    ? "正在导入…"
    : importState === "done"
      ? "已导入工程包"
      : importState === "submitted"
        ? "导入已提交"
        : importState === "attention"
          ? "重新导入工程包…"
          : "导入工程包…";

  return (
    <>
      <button ref={trigger} type="button" className="project-new-button project-home-new-button" disabled={importBusy} onClick={() => setOpen(true)}>新建项目</button>
      {onOpenExistingFolder && isTauri() ? (
        <button type="button" className="secondary project-home-open-folder-button" disabled={importBusy || busy} onClick={onOpenExistingFolder}>打开已有项目库…</button>
      ) : null}
      {isTauri() && <button type="button" className="secondary project-home-open-package-button" disabled={importBusy || busy} title="导入 .mirrorproj 工程包" onClick={() => void importProject()}>{importLabel}</button>}

      {open ? (
        <div className="project-lifecycle-overlay" role="presentation" onMouseDown={close}>
          <form className="project-lifecycle-dialog" role="dialog" aria-modal="true" aria-label="新建项目" onKeyDown={dialogKeys}
            onMouseDown={(event) => event.stopPropagation()} onSubmit={(event) => { event.preventDefault(); if (canCreate) void create(); }}>
            <header className="project-lifecycle-header">
              <h2>新建项目</h2>
              <button type="button" className="dialog-close" disabled={busy} onClick={close}>关闭</button>
            </header>

            <div className="project-lifecycle-body">
              <fieldset className="lifecycle-fields" disabled={busy || Boolean(createdId)} onChange={clearFeedback}>
                <div className="lifecycle-kind" role="group" aria-label="项目来源">
                  <button type="button" aria-pressed={raw} onClick={() => { setInputKind("media-directory"); clearFeedback(); }}>原始素材</button>
                  <button type="button" aria-pressed={!raw} onClick={() => { setInputKind("fcpxml"); clearFeedback(); }}>已有 FCPXML</button>
                </div>
                <label className="lifecycle-field"><span>项目名称</span><input autoFocus required value={name} onChange={(event) => setName(event.target.value)} placeholder="输入项目名称" /></label>
                {raw ? <div className="lifecycle-field">
                  <label htmlFor={rootsId}>原始视频与同期录音目录</label>
                  <div className="lifecycle-path-row">
                    <textarea id={rootsId} required rows={2} value={mediaRoots} onChange={(event) => setMediaRoots(event.target.value)} spellCheck={false} placeholder="每行一个素材目录" />
                    {isTauri() && <button type="button" className="secondary" onClick={() => void chooseMediaRoots()}>选择目录…</button>}
                  </div>
                </div> : <>
                  <FileField label="FCPXML" value={fcpxmlPath} required placeholder="选择 FCPXML 文件"
                    onChange={setFcpxmlPath} onChoose={() => void chooseFile("fcpxml")} />
                  {scriptField}
                </>}
                <details className="lifecycle-optional" key={inputKind}>
                  <summary>{raw ? "剧本与现场场记" : "现场场记"}（选填）{(slatePath || (raw && scriptPath)) && <small>已填写</small>}</summary>
                  <div>
                    {raw && scriptField}
                    <FileField label="现场场记" value={slatePath} placeholder="PDF 或片场照片" onChange={setSlatePath} onChoose={() => void chooseFile("slate")} />
                  </div>
                </details>

                <label className="lifecycle-checkbox">
                  <input type="checkbox" checked={prepareAfterCreate} onChange={(event) => setPrepareAfterCreate(event.target.checked)} />
                  <span>{raw ? "创建后自动同步" : "创建后自动整理"}
                    {!raw && <small>后台整理素材、转写并匹配剧本，进度可在状态中心查看。</small>}
                  </span>
                </label>
              </fieldset>
            </div>
            <footer className="lifecycle-footer">
              {preflight && (!preflight.ready || preflight.warnings.length > 0) ? (
                <div className={`lifecycle-preflight${preflight.ready ? "" : " is-error"}`} role={preflight.ready ? "status" : "alert"}>
                  <strong>{preflight.ready ? "来源提醒" : "还不能创建"}</strong>
                  {preflight.errors.map((error) => <span key={error}>{error}</span>)}
                  {preflight.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              ) : null}

              <div className="lifecycle-actions">
                <p id={feedbackId} className="project-lifecycle-message" aria-live="polite">{feedback}</p>
                <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
                <button type="submit" disabled={busy || !canCreate} aria-describedby={feedbackId}>{busy ? "正在处理…" : createdId ? "重新打开项目" : acceptedWarnings ? "确认并创建" : prepareAfterCreate ? (raw ? "创建并同步" : "创建并整理") : "创建项目"}</button>
              </div>
            </footer>
          </form>
        </div>
      ) : null}
    </>
  );
}
