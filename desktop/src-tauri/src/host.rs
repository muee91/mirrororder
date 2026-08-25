use crate::runtime::{path_with_tools, python_path_with_source, resolve_python_runtime, RuntimeOrigin};
use crate::service_health::probe_service;
use serde::Serialize;
use std::{
    net::TcpListener,
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

const HOST_SERVICE: &str = "mirrororder-host";

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
    healthy: bool,
    health_error: Option<String>,
    pid: Option<u32>,
    base_url: Option<String>,
    workspace_path: Option<String>,
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
                "本机端口 {port} 已被占用（{error}）。如果已有镜序服务，请直接连接；不要误连到其它工作区。"
            )
        })
}

fn health(port: u16) -> Result<(), String> {
    probe_service(port, HOST_SERVICE, Duration::from_millis(400))
}

fn wait_until_ready(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let mut last_error = String::new();
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("检查 Python Host 启动状态失败：{error}"))?
        {
            return Err(format!("Python Host 在健康检查通过前退出：{status}"));
        }
        match health(port) {
            Ok(()) => return Ok(()),
            Err(error) => last_error = error,
        }
        thread::sleep(Duration::from_millis(80));
    }
    Err(format!(
        "Python Host 启动超时：15 秒内未通过 {HOST_SERVICE} 健康检查{}",
        if last_error.is_empty() { String::new() } else { format!("（最后错误：{last_error}）") }
    ))
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
    app: AppHandle,
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
        if health(host.port).is_ok() {
            return Ok(HostLaunchResult {
                pid: host.child.id(),
                base_url: host.base_url.clone(),
                already_running: true,
            });
        }
    }

    // A child may still exist while its HTTP service is no longer healthy. Do
    // not report that stale process as already_running; reap it and restart on
    // the configured port instead of asking operators to drift to 8767/8768.
    if let Some(stale) = slot.take() {
        stop_managed_host(stale)?;
    }

    ensure_loopback_port_available(port)?;
    let runtime = resolve_python_runtime(&app)?;
    let mut command = Command::new(&runtime.python_executable);
    command
        .current_dir(&runtime.core_root)
        .env("PYTHONPATH", python_path_with_source(&runtime.source_dir)?)
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
    if let Some(path) = path_with_tools(runtime.tool_bin.as_deref())? {
        command.env("PATH", path);
    }
    if runtime.origin == RuntimeOrigin::PackagedResource {
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法解析 Desktop app-data 目录：{error}"))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("无法创建 Desktop app-data 目录 {}：{error}", data_dir.display()))?;
        command
            .env("MIRRORORDER_PACKAGED_RUNTIME", "1")
            .env("MIRRORORDER_DATA_DIR", &data_dir)
            .env("MIRRORORDER_DEVICE_STATE_DIR", &data_dir)
            .env(
                "MIRRORORDER_MULTICAM_SYNC_ROOT",
                runtime.core_root.join("vendor").join("multicam-audio-sync"),
            );
    }

    let mut child = command
        .spawn()
        .map_err(|error| format!("无法启动 Python Host：{error}"))?;
    if let Err(error) = wait_until_ready(&mut child, port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

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
    let health_result = host.map(|item| health(item.port));
    let healthy = matches!(health_result, Some(Ok(())));
    let health_error = match health_result {
        Some(Err(error)) => Some(error),
        _ => None,
    };
    Ok(HostProcessStatus {
        running: host.is_some(),
        healthy,
        health_error,
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
