use crate::runtime::{path_with_tools, python_path_with_source, resolve_python_runtime, RuntimeOrigin};
use serde::Serialize;
use std::{
    net::{SocketAddr, TcpListener, TcpStream, UdpSocket},
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
    thread,
    time::{Duration, Instant},
};
use tauri::{AppHandle, Manager, State};

#[derive(Clone, Debug, PartialEq, Eq)]
struct GatewayConfig {
    workspace_paths: Vec<PathBuf>,
    port: u16,
    local_only: bool,
    trusted_lan: bool,
    pairing_code: String,
}

struct ManagedGateway {
    child: Child,
    config: GatewayConfig,
    base_url: String,
    lan_url: Option<String>,
}

#[derive(Default)]
pub struct GatewayManager {
    child: Mutex<Option<ManagedGateway>>,
}

#[derive(Serialize)]
pub struct GatewayLaunchResult {
    pid: u32,
    base_url: String,
    lan_url: Option<String>,
    already_running: bool,
    workspace_paths: Vec<String>,
    port: u16,
    local_only: bool,
    trusted_lan: bool,
    pairing_code: String,
}

#[derive(Serialize)]
pub struct GatewayProcessStatus {
    running: bool,
    pid: Option<u32>,
    base_url: Option<String>,
    lan_url: Option<String>,
    workspace_paths: Vec<String>,
    port: Option<u16>,
    local_only: Option<bool>,
    trusted_lan: Option<bool>,
    pairing_code: Option<String>,
}

fn normalize_workspace_path(value: &str) -> Result<PathBuf, String> {
    let raw = value.trim();
    if raw.is_empty() {
        return Err("Workspace 路径不能为空".to_string());
    }
    let path = PathBuf::from(raw);
    if !path.exists() {
        return Err(format!("Workspace 不存在：{}", path.display()));
    }
    let candidate = if path.is_dir() {
        let config = path.join("workspace.toml");
        if !config.is_file() {
            return Err(format!("目录缺少 workspace.toml：{}", path.display()));
        }
        path
    } else {
        if path.file_name().and_then(|value| value.to_str()) != Some("workspace.toml") {
            return Err(format!("Workspace 文件必须是 workspace.toml：{}", path.display()));
        }
        path
    };
    Ok(candidate.canonicalize().unwrap_or(candidate))
}

fn normalize_workspace_paths(values: Vec<String>) -> Result<Vec<PathBuf>, String> {
    let mut paths = Vec::new();
    for value in values {
        let path = normalize_workspace_path(&value)?;
        if !paths.contains(&path) {
            paths.push(path);
        }
    }
    if paths.is_empty() {
        return Err("Team Web Gateway 至少需要一个 Workspace".to_string());
    }
    Ok(paths)
}

fn validate_port(port: u16) -> Result<u16, String> {
    if port == 0 {
        return Err("Gateway 端口不能为 0".to_string());
    }
    Ok(port)
}

fn ensure_port_available(port: u16, local_only: bool) -> Result<(), String> {
    let host = if local_only { "127.0.0.1" } else { "0.0.0.0" };
    TcpListener::bind((host, port))
        .map(|listener| drop(listener))
        .map_err(|error| format!("Gateway 端口 {port} 已被占用（{error}）"))
}

fn wait_until_ready(child: &mut Child, port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(15);
    let address = SocketAddr::from(([127, 0, 0, 1], port));
    while Instant::now() < deadline {
        if let Some(status) = child
            .try_wait()
            .map_err(|error| format!("检查 Gateway 启动状态失败：{error}"))?
        {
            return Err(format!("Team Web Gateway 在监听端口前退出：{status}"));
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(60));
    }
    Err(format!("Team Web Gateway 启动超时：15 秒内未监听 127.0.0.1:{port}"))
}

fn local_lan_address() -> Option<String> {
    let socket = UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let address = socket.local_addr().ok()?.ip();
    if address.is_loopback() || address.is_unspecified() {
        None
    } else {
        Some(address.to_string())
    }
}

fn lan_url(port: u16, local_only: bool) -> Option<String> {
    if local_only {
        return None;
    }
    local_lan_address().map(|address| format!("http://{address}:{port}"))
}

fn reap_if_finished(slot: &mut Option<ManagedGateway>) -> Result<(), String> {
    let finished = match slot.as_mut() {
        Some(gateway) => gateway
            .child
            .try_wait()
            .map_err(|error| format!("检查 Gateway 进程失败：{error}"))?
            .is_some(),
        None => false,
    };
    if finished {
        *slot = None;
    }
    Ok(())
}

fn stop_managed_gateway(mut gateway: ManagedGateway) -> Result<(), String> {
    if gateway
        .child
        .try_wait()
        .map_err(|error| format!("检查 Gateway 进程失败：{error}"))?
        .is_none()
    {
        gateway
            .child
            .kill()
            .map_err(|error| format!("停止 Gateway 进程失败：{error}"))?;
        gateway
            .child
            .wait()
            .map_err(|error| format!("等待 Gateway 进程退出失败：{error}"))?;
    }
    Ok(())
}

fn public_result(gateway: &ManagedGateway, already_running: bool) -> GatewayLaunchResult {
    GatewayLaunchResult {
        pid: gateway.child.id(),
        base_url: gateway.base_url.clone(),
        lan_url: gateway.lan_url.clone(),
        already_running,
        workspace_paths: gateway
            .config
            .workspace_paths
            .iter()
            .map(|path| path.display().to_string())
            .collect(),
        port: gateway.config.port,
        local_only: gateway.config.local_only,
        trusted_lan: gateway.config.trusted_lan,
        pairing_code: gateway.config.pairing_code.clone(),
    }
}

impl Drop for GatewayManager {
    fn drop(&mut self) {
        if let Ok(slot) = self.child.get_mut() {
            if let Some(gateway) = slot.take() {
                let _ = stop_managed_gateway(gateway);
            }
        }
    }
}

#[tauri::command]
pub fn start_team_gateway(
    app: AppHandle,
    manager: State<'_, GatewayManager>,
    workspace_paths: Vec<String>,
    port: Option<u16>,
    local_only: Option<bool>,
    trusted_lan: Option<bool>,
    pairing_code: Option<String>,
) -> Result<GatewayLaunchResult, String> {
    let workspace_paths = normalize_workspace_paths(workspace_paths)?;
    let port = validate_port(port.unwrap_or(8766))?;
    let local_only = local_only.unwrap_or(false);
    let trusted_lan = trusted_lan.unwrap_or(false);
    let pairing_code = if trusted_lan {
        String::new()
    } else {
        let value = pairing_code.unwrap_or_default().trim().to_string();
        if value.len() < 6 || value.len() > 80 {
            return Err("首次配对模式需要 6–80 位 pairing code".to_string());
        }
        value
    };
    let config = GatewayConfig {
        workspace_paths,
        port,
        local_only,
        trusted_lan,
        pairing_code,
    };

    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Gateway 进程状态锁已损坏".to_string())?;
    reap_if_finished(&mut slot)?;
    if let Some(gateway) = slot.as_ref() {
        if gateway.config != config {
            return Err(format!(
                "Team Web Gateway 已运行在 {}。配置变更需要先停止当前 Gateway。",
                gateway.base_url
            ));
        }
        return Ok(public_result(gateway, true));
    }

    ensure_port_available(port, local_only)?;
    let runtime = resolve_python_runtime(&app)?;
    let mut command = Command::new(&runtime.python_executable);
    command
        .current_dir(&runtime.core_root)
        .env("PYTHONPATH", python_path_with_source(&runtime.source_dir)?)
        .arg("-m")
        .arg("script_organizer.cli")
        .arg("gateway");
    for path in &config.workspace_paths {
        command.arg(path);
    }
    command.arg("--port").arg(config.port.to_string());
    if config.local_only {
        command.arg("--local-only");
    }
    if config.trusted_lan {
        command.arg("--trusted-lan");
    } else {
        command.arg("--pairing-code").arg(&config.pairing_code);
    }
    command
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
        .map_err(|error| format!("无法启动 Team Web Gateway：{error}"))?;
    if let Err(error) = wait_until_ready(&mut child, config.port) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }

    let base_url = format!("http://127.0.0.1:{}", config.port);
    let lan_url = lan_url(config.port, config.local_only);
    *slot = Some(ManagedGateway {
        child,
        config,
        base_url,
        lan_url,
    });
    Ok(public_result(slot.as_ref().expect("gateway inserted"), false))
}

#[tauri::command]
pub fn team_gateway_status(
    manager: State<'_, GatewayManager>,
) -> Result<GatewayProcessStatus, String> {
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Gateway 进程状态锁已损坏".to_string())?;
    reap_if_finished(&mut slot)?;
    let gateway = slot.as_ref();
    Ok(GatewayProcessStatus {
        running: gateway.is_some(),
        pid: gateway.map(|item| item.child.id()),
        base_url: gateway.map(|item| item.base_url.clone()),
        lan_url: gateway.and_then(|item| item.lan_url.clone()),
        workspace_paths: gateway
            .map(|item| {
                item.config
                    .workspace_paths
                    .iter()
                    .map(|path| path.display().to_string())
                    .collect()
            })
            .unwrap_or_default(),
        port: gateway.map(|item| item.config.port),
        local_only: gateway.map(|item| item.config.local_only),
        trusted_lan: gateway.map(|item| item.config.trusted_lan),
        pairing_code: gateway.map(|item| item.config.pairing_code.clone()),
    })
}

#[tauri::command]
pub fn stop_team_gateway(manager: State<'_, GatewayManager>) -> Result<(), String> {
    let mut slot = manager
        .child
        .lock()
        .map_err(|_| "Gateway 进程状态锁已损坏".to_string())?;
    if let Some(gateway) = slot.take() {
        stop_managed_gateway(gateway)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{lan_url, validate_port};

    #[test]
    fn rejects_zero_gateway_port() {
        assert!(validate_port(0).is_err());
        assert_eq!(validate_port(8766).unwrap(), 8766);
    }

    #[test]
    fn local_only_never_exposes_lan_url() {
        assert_eq!(lan_url(8766, true), None);
    }
}
