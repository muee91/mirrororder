use serde::Serialize;
use std::{
    env,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::State;

#[derive(Default)]
pub struct HostManager {
    child: Mutex<Option<Child>>,
}

#[derive(Serialize)]
pub struct HostLaunchResult {
    pid: u32,
    base_url: String,
    already_running: bool,
}

#[derive(Serialize)]
pub struct HostProcessStatus {
    running: bool,
    pid: Option<u32>,
}

fn core_root() -> PathBuf {
    env::var_os("MIRRORORDER_CORE_ROOT")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../.."))
}

fn python_executable() -> String {
    env::var("MIRRORORDER_PYTHON").unwrap_or_else(|_| {
        if cfg!(target_os = "windows") {
            "python".to_string()
        } else {
            "python3".to_string()
        }
    })
}

fn python_path_with_core(core: &Path) -> Result<std::ffi::OsString, String> {
    let mut paths = vec![core.join("src")];
    if let Some(existing) = env::var_os("PYTHONPATH") {
        paths.extend(env::split_paths(&existing));
    }
    env::join_paths(paths).map_err(|error| format!("无法构造 PYTHONPATH：{error}"))
}

fn reap_if_finished(slot: &mut Option<Child>) -> Result<(), String> {
    let finished = match slot.as_mut() {
        Some(child) => child
            .try_wait()
            .map_err(|error| format!("检查 Host 进程失败：{error}"))?
            .is_some(),
        None => false,
    };
    if finished {
        *slot = None;
    }
    Ok(())
}

#[tauri::command]
pub fn start_python_host(
    manager: State<'_, HostManager>,
    workspace_path: String,
    port: Option<u16>,
) -> Result<HostLaunchResult, String> {
    let workspace_path = workspace_path.trim();
    if workspace_path.is_empty() {
        return Err("workspace_path 不能为空".into());
    }
    if !Path::new(workspace_path).exists() {
        return Err(format!("Workspace 不存在：{workspace_path}"));
    }

    let port = port.unwrap_or(8765);
    let base_url = format!("http://127.0.0.1:{port}");
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Host 进程状态锁已损坏".to_string())?;
    reap_if_finished(&mut slot)?;

    if let Some(child) = slot.as_ref() {
        return Ok(HostLaunchResult {
            pid: child.id(),
            base_url,
            already_running: true,
        });
    }

    let core = core_root();
    let source_dir = core.join("src");
    if !source_dir.join("script_organizer").is_dir() {
        return Err(format!(
            "找不到 MirrorOrder Python Core：{}；可用 MIRRORORDER_CORE_ROOT 覆盖",
            source_dir.display()
        ));
    }

    let mut command = Command::new(python_executable());
    command
        .current_dir(&core)
        .env("PYTHONPATH", python_path_with_core(&core)?)
        .arg("-m")
        .arg("script_organizer.cli")
        .arg("serve")
        .arg(workspace_path)
        .arg("--local-only")
        .arg("--port")
        .arg(port.to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());

    let child = command
        .spawn()
        .map_err(|error| format!("无法启动 Python Host：{error}"))?;
    let pid = child.id();
    *slot = Some(child);

    Ok(HostLaunchResult {
        pid,
        base_url,
        already_running: false,
    })
}

#[tauri::command]
pub fn host_process_status(manager: State<'_, HostManager>) -> Result<HostProcessStatus, String> {
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Host 进程状态锁已损坏".to_string())?;
    reap_if_finished(&mut slot)?;
    Ok(HostProcessStatus {
        running: slot.is_some(),
        pid: slot.as_ref().map(Child::id),
    })
}

#[tauri::command]
pub fn stop_python_host(manager: State<'_, HostManager>) -> Result<(), String> {
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Host 进程状态锁已损坏".to_string())?;
    if let Some(mut child) = slot.take() {
        if child
            .try_wait()
            .map_err(|error| format!("检查 Host 进程失败：{error}"))?
            .is_none()
        {
            child
                .kill()
                .map_err(|error| format!("停止 Host 进程失败：{error}"))?;
            child
                .wait()
                .map_err(|error| format!("等待 Host 进程退出失败：{error}"))?;
        }
    }
    Ok(())
}
