import { isTauri } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import { PlatformClient } from "../../api/platform";
import { useMemo, useRef, useState, type KeyboardEvent } from "react";
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

function sourceMessage(inputKind: "fcpxml" | "media-directory"): string {
  return inputKind === "fcpxml"
    ? "选择 FCPXML 文件，并按需指定剧本。"
    : "选择原始视频和同期录音所在的目录。";
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
  const [fcpxmlPath, setFcpxmlPath] = useState("");
  const [mediaRoots, setMediaRoots] = useState("");
  const [prepareAfterCreate, setPrepareAfterCreate] = useState(true);
  const [preflight, setPreflight] = useState<ProjectPreflight | null>(null);
  const [message, setMessage] = useState(() => sourceMessage("media-directory"));
  const [busy, setBusy] = useState(false);
  const [createdId, setCreatedId] = useState("");
  const [acceptedWarnings, setAcceptedWarnings] = useState("");
  const inFlight = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const [importBusy, setImportBusy] = useState(false);
  const [importState, setImportState] = useState<"idle" | "submitted" | "done" | "attention">("idle");

  function payload(): ProjectCreatePayload {
    return {
      name: name.trim(),
      input_kind: inputKind,
      script: scriptPath.trim() || undefined,
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
    setCreatedId("");
    setAcceptedWarnings("");
    setInputKind("media-directory");
    setPrepareAfterCreate(true);
    setPreflight(null);
    setMessage(sourceMessage("media-directory"));
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
      "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
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
          setMessage("请处理来源检查中列出的问题。");
          return;
        }
        const warningKey = JSON.stringify([values, checked.warnings]);
        if (checked.warnings.length && warningKey !== acceptedWarnings) {
          setAcceptedWarnings(warningKey);
          setMessage("请检查来源提醒，再确认创建。");
          return;
        }
        setMessage("正在创建项目…");
        const created = await client.createProject(values);
        savedId = created.project_id;
        setCreatedId(savedId);

        if (prepareAfterCreate) {
          try {
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

  const sourceReady = inputKind === "fcpxml" ? Boolean(fcpxmlPath.trim()) : rootsFromText(mediaRoots).length > 0;
  const canCreate = Boolean(createdId || (name.trim() && sourceReady && (inputKind === "media-directory" || scriptPath.trim())));
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
      {onOpenExistingFolder ? (
        <button type="button" className="secondary project-home-open-folder-button" disabled={importBusy || busy || !isTauri()} onClick={onOpenExistingFolder}>打开已有工程…</button>
      ) : null}
      <button type="button" className="secondary project-home-open-package-button" disabled={importBusy || busy || !isTauri()} onClick={() => void importProject()}>{importLabel}</button>
      <button ref={trigger} type="button" className="project-new-button project-home-new-button" disabled={importBusy} onClick={() => setOpen(true)}>新建项目</button>

      {open ? (
        <div className="project-lifecycle-overlay" role="presentation" onMouseDown={close}>
          <section className="project-lifecycle-dialog" role="dialog" aria-modal="true" aria-label="新建项目" onKeyDown={dialogKeys} onMouseDown={(event) => event.stopPropagation()}>
            <header className="project-lifecycle-header">
              <div>
                <h2>新建项目</h2>
              </div>
              <button type="button" className="dialog-close" disabled={busy} onClick={close}>关闭</button>
            </header>

            <div className="project-lifecycle-body">
              <div className="lifecycle-kind" aria-label="项目来源">
                <button type="button" aria-pressed={inputKind === "media-directory"} className={inputKind === "media-directory" ? "is-active" : ""} onClick={() => { setInputKind("media-directory"); setPreflight(null); setMessage(sourceMessage("media-directory")); }}>原始素材</button>
                <button type="button" aria-pressed={inputKind === "fcpxml"} className={inputKind === "fcpxml" ? "is-active" : ""} onClick={() => { setInputKind("fcpxml"); setPreflight(null); setMessage(sourceMessage("fcpxml")); }}>已有 FCPXML</button>
              </div>

              <label><span>项目名称</span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setPreflight(null); }} placeholder="输入项目名称" /></label>

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
                  <span>原始视频与同期录音目录</span>
                  <textarea rows={3} value={mediaRoots} onChange={(event) => { setMediaRoots(event.target.value); setPreflight(null); }} spellCheck={false} placeholder="每行一个素材目录" />
                  <button type="button" className="secondary choose-roots" disabled={!isTauri()} onClick={() => void chooseMediaRoots()}>选择目录…</button>
                </label>
              )}

              <label>
                <span>{inputKind === "media-directory" ? "剧本（可稍后导入）" : "剧本"}</span>
                <div className="lifecycle-path-row">
                  <input value={scriptPath} onChange={(event) => { setScriptPath(event.target.value); setPreflight(null); }} spellCheck={false} placeholder="选择剧本文件" />
                  <button type="button" className="secondary" disabled={!isTauri()} onClick={() => void chooseFile("script")}>选择…</button>
                </div>
              </label>

              <label className="lifecycle-checkbox">
                <input type="checkbox" checked={prepareAfterCreate} onChange={(event) => setPrepareAfterCreate(event.target.checked)} />
                <span><strong>{inputKind === "media-directory" ? "创建后自动同步" : "创建后自动整理"}</strong><small>{inputKind === "media-directory" ? "先交付同步工程。转写、场记与剧本关联不会阻塞剪辑师开工。" : "后台整理素材、转写并匹配剧本；进度在状态中心查看。"}</small></span>
              </label>

              {preflight && (!preflight.ready || preflight.warnings.length > 0) ? (
                <div className={`lifecycle-preflight${preflight.ready ? "" : " is-error"}`} role={preflight.ready ? "status" : "alert"}>
                  <strong>{preflight.ready ? "来源提醒" : "还不能创建"}</strong>
                  {preflight.errors.map((error) => <span key={error}>{error}</span>)}
                  {preflight.warnings.map((warning) => <span key={warning}>{warning}</span>)}
                </div>
              ) : null}

              <p className="project-lifecycle-message" aria-live="polite">{message}</p>
              <div className="lifecycle-actions">
                <button type="button" className="secondary" disabled={busy} onClick={close}>取消</button>
                <button type="button" disabled={busy || !canCreate} onClick={() => void create()}>{createdId ? "重新打开项目" : prepareAfterCreate ? (inputKind === "media-directory" ? "创建并同步" : "创建并整理") : "创建项目"}</button>
              </div>
            </div>
          </section>
        </div>
      ) : null}
    </>
  );
}
