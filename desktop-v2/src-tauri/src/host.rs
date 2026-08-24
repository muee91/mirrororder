use serde::Serialize;
use std::{
    env,
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::Mutex,
};
use tauri::State;

struct ManagedHost {
    child: Child,
    workspace_path: PathBuf,
    base_url: String,
    port: u16,
}

#[derive(Default)]
pub struct HostManager {
    child: Mutex<Option<ManagedHost>>,
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
    base_url: Option<String>,
    workspace_path: Option<String>,
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

fn normalize_workspace_path(value: &str) -> Result<PathBuf, String> {
    let path = PathBuf::from(value);
    if !path.exists() {
        return Err(format!("Workspace 不存在：{}", path.display()));
    }
    Ok(path.canonicalize().unwrap_or(path))
}

fn validate_port(port: u16) -> Result<u16, String> {
    if port == 0 {
        return Err("Host 端口不能为 0".to_string());
    }
    Ok(port)
}

fn ensure_loopback_port_available(port: u16) -> Result<(), String> {
    TcpListener::bind(("127.0.0.1", port))
        .map(|listener| drop(listener))
        .map_err(|error| {
            format!(
                "本机端口 {port} 已被占用（{error}）。如果已有镜序 Host，请直接连接；不要让 Desktop v2 误连到其它工作区。"
            )
        })
}

fn reap_if_finished(slot: &mut Option<ManagedHost>) -> Result<(), String> {
    let finished = match slot.as_mut() {
        Some(host) => host
            .child
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

fn stop_managed_host(mut host: ManagedHost) -> Result<(), String> {
    if host
        .child
        .try_wait()
        .map_err(|error| format!("检查 Host 进程失败：{error}"))?
        .is_none()
    {
        host.child
            .kill()
            .map_err(|error| format!("停止 Host 进程失败：{error}"))?;
        host.child
            .wait()
            .map_err(|error| format!("等待 Host 进程退出失败：{error}"))?;
    }
    Ok(())
}

impl Drop for HostManager {
    fn drop(&mut self) {
        if let Ok(slot) = self.child.get_mut() {
            if let Some(host) = slot.take() {
                let _ = stop_managed_host(host);
            }
        }
    }
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

    let workspace_path = normalize_workspace_path(workspace_path)?;
    let port = validate_port(port.unwrap_or(8765))?;
    let base_url = format!("http://127.0.0.1:{port}");
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Host 进程状态锁已损坏".to_string())?;
    reap_if_finished(&mut slot)?;

    if let Some(host) = slot.as_ref() {
        if host.workspace_path != workspace_path || host.port != port {
            return Err(format!(
                "已有 Python Host 正在运行：{} · {}。请先停止它，或直接连接现有 Host。",
                host.base_url,
                host.workspace_path.display()
            ));
        }
        return Ok(HostLaunchResult {
            pid: host.child.id(),
            base_url: host.base_url.clone(),
            already_running: true,
        });
    }

    ensure_loopback_port_available(port)?;

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
        .arg(&workspace_path)
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
    *slot = Some(ManagedHost {
        child,
        workspace_path,
        base_url: base_url.clone(),
        port,
    });

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
    let host = slot.as_ref();
    Ok(HostProcessStatus {
        running: host.is_some(),
        pid: host.map(|item| item.child.id()),
        base_url: host.map(|item| item.base_url.clone()),
        workspace_path: host.map(|item| item.workspace_path.display().to_string()),
    })
}

#[tauri::command]
pub fn stop_python_host(manager: State<'_, HostManager>) -> Result<(), String> {
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Host 进程状态锁已损坏".to_string())?;
    if let Some(host) = slot.take() {
        stop_managed_host(host)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{ensure_loopback_port_available, validate_port};
    use std::net::TcpListener;

    #[test]
    fn rejects_zero_port() {
        assert!(validate_port(0).is_err());
        assert_eq!(validate_port(8765).unwrap(), 8765);
    }

    #[test]
    fn detects_an_occupied_loopback_port() {
        let listener = TcpListener::bind(("127.0.0.1", 0)).unwrap();
        let port = listener.local_addr().unwrap().port();
        let error = ensure_loopback_port_available(port).unwrap_err();
        assert!(error.contains("已被占用"));
        drop(listener);
        assert!(ensure_loopback_port_available(port).is_ok());
    }
}
