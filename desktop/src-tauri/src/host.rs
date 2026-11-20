use crate::runtime::{packaged_python_home, path_with_tools, python_path_with_source, resolve_python_runtime, RuntimeOrigin};
use crate::service_health::probe_service;
use serde::Serialize;
use std::{
    net::TcpListener,
    path::{Path, PathBuf},
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

#[cfg(unix)]
fn listening_pids(port: u16) -> Vec<u32> {
    let selector = format!("-iTCP:{port}");
    let Ok(output) = Command::new("lsof")
        .args(["-nP", selector.as_str(), "-sTCP:LISTEN", "-t"])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
        .collect()
}

#[cfg(not(unix))]
fn listening_pids(_port: u16) -> Vec<u32> {
    Vec::new()
}

#[cfg(unix)]
fn process_command_line(pid: u32) -> Option<String> {
    let pid_arg = pid.to_string();
    let output = Command::new("ps")
        .args(["-p", pid_arg.as_str(), "-o", "command="])
        .output()
        .ok()?;
    let command = String::from_utf8_lossy(&output.stdout).trim().to_string();
    (!command.is_empty()).then_some(command)
}

#[cfg(not(unix))]
fn process_command_line(_pid: u32) -> Option<String> {
    None
}

fn command_mentions_workspace(command: &str, workspace_path: &PathBuf) -> bool {
    let direct = workspace_path.to_string_lossy();
    if command.contains(direct.as_ref()) {
        return true;
    }
    let config_path = if workspace_path.is_dir() {
        workspace_path.join("workspace.toml")
    } else {
        workspace_path.clone()
    };
    command.contains(&config_path.to_string_lossy().to_string())
}

fn is_same_workspace_host_command(command: &str, port: u16, workspace_path: &PathBuf) -> bool {
    let args: Vec<&str> = command.split_whitespace().collect();
    let has_host_module = args.windows(2).any(|window| window == ["-m", "script_organizer.cli"]);
    let has_serve_command = args.iter().any(|arg| *arg == "serve" || *arg == "run");
    let has_local_only = args.iter().any(|arg| *arg == "--local-only");
    let port_value = port.to_string();
    let has_port = args
        .windows(2)
        .any(|window| window[0] == "--port" && window[1] == port_value);
    has_host_module
        && has_serve_command
        && has_local_only
        && has_port
        && command_mentions_workspace(command, workspace_path)
}

#[cfg(unix)]
fn process_is_alive(pid: u32) -> bool {
    let pid_arg = pid.to_string();
    Command::new("kill")
        .args(["-0", pid_arg.as_str()])
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

#[cfg(not(unix))]
fn process_is_alive(_pid: u32) -> bool {
    false
}

#[cfg(unix)]
fn terminate_process(pid: u32, label: &str) -> Result<(), String> {
    if pid == std::process::id() {
        return Err("拒绝回收当前 Desktop 进程".to_string());
    }
    let pid_arg = pid.to_string();
    let status = Command::new("kill")
        .args(["-TERM", pid_arg.as_str()])
        .status()
        .map_err(|error| format!("回收{label}失败：{error}"))?;
    if !status.success() && process_is_alive(pid) {
        return Err(format!("回收{label}失败：进程 {pid} 拒绝退出"));
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    while process_is_alive(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(50));
    }
    if process_is_alive(pid) {
        let _ = Command::new("kill").args(["-KILL", pid_arg.as_str()]).status();
    }
    Ok(())
}

#[cfg(not(unix))]
fn terminate_process(_pid: u32, label: &str) -> Result<(), String> {
    Err(format!("当前平台不支持安全回收{label}"))
}

fn reclaim_stale_host(port: u16, workspace_path: &PathBuf) -> Result<bool, String> {
    if ensure_loopback_port_available(port).is_ok() {
        return Ok(false);
    }

    let mut reclaimed = false;
    for pid in listening_pids(port) {
        let Some(command) = process_command_line(pid) else {
            continue;
        };
        if is_same_workspace_host_command(&command, port, workspace_path) {
            reclaimed = true;
            terminate_process(pid, "遗留 Python Host")?;
        }
    }
    if !reclaimed {
        ensure_loopback_port_available(port)?;
        return Ok(false);
    }

    let deadline = Instant::now() + Duration::from_secs(3);
    loop {
        match ensure_loopback_port_available(port) {
            Ok(()) => return Ok(true),
            Err(_error) if Instant::now() < deadline => thread::sleep(Duration::from_millis(50)),
            Err(error) => return Err(error),
        }
    }
}

#[cfg(unix)]
fn same_desktop_process_pids() -> Vec<u32> {
    let Ok(executable) = std::env::current_exe() else {
        return Vec::new();
    };
    let executable = executable.to_string_lossy();
    let Ok(output) = Command::new("ps")
        .args(["-axo", "pid=,command="])
        .output()
    else {
        return Vec::new();
    };
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.trim_start().splitn(2, char::is_whitespace);
            let pid = fields.next()?.parse::<u32>().ok()?;
            let command = fields.next()?.trim();
            (pid != std::process::id() && command.starts_with(executable.as_ref())).then_some(pid)
        })
        .collect()
}

#[cfg(not(unix))]
fn same_desktop_process_pids() -> Vec<u32> {
    Vec::new()
}

fn reclaim_previous_desktop_process() -> Result<(), String> {
    for pid in same_desktop_process_pids() {
        terminate_process(pid, "旧版镜序 Desktop")?;
    }
    Ok(())
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

    if let Some(stale) = slot.take() {
        stop_managed_host(stale)?;
    }

    // An app bundle can be replaced while the previous Desktop process is
    // still alive. Its Python child then survives the file replacement and
    // would otherwise strand the fixed Host port. Reclaim only a local
    // MirrorOrder Host serving this exact workspace; arbitrary listeners and
    // other workspaces remain protected by the normal port error.
    let reclaimed_stale_host = reclaim_stale_host(port, &workspace_path)?;
    if reclaimed_stale_host {
        // The stale Host may still be owned by an older Desktop process whose
        // bundle was replaced in place. Stop that parent too; its Gateway, if
        // any, will observe the parent loss through the same watchdog.
        reclaim_previous_desktop_process()?;
    }
    let runtime = resolve_python_runtime(&app)?;
    let mut command = Command::new(&runtime.python_executable);
    command
        .current_dir(&runtime.core_root)
        .env("PYTHONPATH", python_path_with_source(&runtime.source_dir)?)
        // Packaged code lives inside a signed, read-only bundle: letting CPython write
        // __pycache__ there breaks the bundle seal and fails outright on a mounted DMG.
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .arg("-m")
        .arg("script_organizer.cli")
        .arg("serve")
        .arg(&workspace_path)
        .arg("--local-only")
        .arg("--port")
        .arg(port.to_string())
        .env("MIRRORORDER_PARENT_PID", std::process::id().to_string())
        .stdin(Stdio::null())
        .stdout(Stdio::inherit())
        .stderr(Stdio::inherit());
    if let Some(path) = path_with_tools(runtime.tool_bin.as_deref())? {
        command.env("PATH", path);
    }
    // Never inherit a caller-selected executable for PDF tasks.
    command.env_remove("MIRRORORDER_NATIVE_PDF_HELPER");
    if runtime.origin == RuntimeOrigin::PackagedResource {
        if let Ok(helper) = app.path().resolve("native/paper-pdf-render", tauri::path::BaseDirectory::Resource) {
            if helper.is_file() && std::fs::symlink_metadata(&helper).map(|m| !m.file_type().is_symlink()).unwrap_or(false) {
                command.env("MIRRORORDER_NATIVE_PDF_HELPER", helper);
            }
        }
        let data_dir = app
            .path()
            .app_data_dir()
            .map_err(|error| format!("无法解析 Desktop app-data 目录：{error}"))?;
        std::fs::create_dir_all(&data_dir)
            .map_err(|error| format!("无法创建 Desktop app-data 目录 {}：{error}", data_dir.display()))?;
        if let Some(python_home) = packaged_python_home(&runtime) {
            command.env("PYTHONHOME", python_home);
        }
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
    let healthy = health_result.as_ref().is_some_and(|result| result.is_ok());
    let health_error = health_result.and_then(Result::err);
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
    shutdown(&manager)
}

pub fn shutdown(manager: &HostManager) -> Result<(), String> {
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
    use super::{
        ensure_loopback_port_available, is_same_workspace_host_command, shutdown, validate_port,
        HostManager, ManagedHost,
    };
    use std::{
        net::TcpListener,
        path::PathBuf,
        process::Command,
        thread,
        time::Duration,
    };

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
        let mut released = false;
        for _ in 0..20 {
            if ensure_loopback_port_available(port).is_ok() {
                released = true;
                break;
            }
            thread::sleep(Duration::from_millis(5));
        }
        assert!(released);
    }

    #[test]
    fn identifies_only_the_same_local_host_workspace_for_reclamation() {
        let workspace = PathBuf::from("/fixture/Code workspace/项目");
        let command = format!(
            "/Applications/镜序.app/Contents/Resources/mirrororder-python/bin/python3 -m script_organizer.cli serve '{}' --local-only --port 8765",
            workspace.display()
        );
        assert!(is_same_workspace_host_command(&command, 8765, &workspace));
        assert!(!is_same_workspace_host_command(
            &command.replace(workspace.to_string_lossy().as_ref(), "/tmp/other-workspace"),
            8765,
            &workspace,
        ));
        assert!(!is_same_workspace_host_command(
            &command.replace("--local-only", "--host 0.0.0.0"),
            8765,
            &workspace,
        ));
    }

    #[cfg(unix)]
    #[test]
    fn owned_private_consumers_resolve_directory_to_the_same_manifest_as_explicit_file() {
        let dir = std::env::temp_dir().join(format!(
            "mirrororder-host-manifest-{}",
            std::process::id()
        ));
        std::fs::create_dir(&dir).unwrap();
        let manifest = dir.join("workspace.toml");
        let other = dir.join("explicit-test.toml");
        std::fs::write(&manifest, "[workspace]\n").unwrap();
        std::fs::write(&other, "[workspace]\n").unwrap();
        let manager = HostManager::default();
        assert!(super::scene_interval_workspace(&manager).is_err());
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        *manager.child.lock().unwrap() = Some(ManagedHost {
            child,
            workspace_path: dir.clone(),
            base_url: "http://127.0.0.1:8765".to_string(),
            port: 8765,
        });
        let result = super::scene_interval_workspace(&manager).unwrap();
        assert_eq!(result, manifest.canonicalize().unwrap());
        manager.child.lock().unwrap().as_mut().unwrap().workspace_path = manifest.clone();
        assert_eq!(super::scene_interval_workspace(&manager).unwrap(), result);
        manager.child.lock().unwrap().as_mut().unwrap().workspace_path = other.clone();
        assert_eq!(super::scene_interval_workspace(&manager).unwrap(), other.canonicalize().unwrap());
        manager.child.lock().unwrap().as_mut().unwrap().workspace_path = dir.clone();
        std::fs::remove_file(&manifest).unwrap();
        assert!(super::scene_interval_workspace(&manager).is_err());
        std::fs::create_dir(&manifest).unwrap();
        assert!(super::scene_interval_workspace(&manager).is_err());
        shutdown(&manager).unwrap();
        std::fs::remove_dir(&manifest).unwrap();
        std::fs::remove_file(&other).unwrap();
        std::fs::remove_dir(&dir).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn shutdown_stops_the_managed_host_child() {
        let child = Command::new("sleep").arg("30").spawn().unwrap();
        let manager = HostManager::default();
        *manager.child.lock().unwrap() = Some(ManagedHost {
            child,
            workspace_path: PathBuf::from("/tmp/workspace"),
            base_url: "http://127.0.0.1:8765".to_string(),
            port: 8765,
        });

        shutdown(&manager).unwrap();
        assert!(manager.child.lock().unwrap().is_none());
    }
}

// Like the Python Host CLI's workspace resolver, a selected directory denotes
// its workspace.toml. Private consumers open the manifest directly; normalize
// only the path owned by the running Host, not a fresh renderer-supplied path.
fn managed_workspace_config(path: &Path) -> Result<PathBuf, String> {
    let candidate = if path.is_dir() {
        path.join("workspace.toml")
    } else {
        path.to_path_buf()
    };
    let canonical = candidate
        .canonicalize()
        .map_err(|_| "managed workspace configuration unavailable")?;
    if !canonical.is_file() {
        return Err("managed workspace configuration unavailable".into());
    }
    Ok(canonical)
}

/// Workspace comes only from the currently owned Host, never renderer paths.
pub(crate) fn scene_interval_workspace(manager: &HostManager) -> Result<PathBuf, String> {
    trusted_interval_workspace(manager, None)
}
pub(crate) fn trusted_interval_workspace(manager: &HostManager, expected_base: Option<&str>) -> Result<PathBuf, String> {
    let mut slot = manager.child.lock().map_err(|_| "Host state unavailable")?;
    let host = slot.as_mut().ok_or("managed Host is not running")?;
    if expected_base.is_some_and(|url| url != host.base_url.as_str()) {
        return Err("电子场记板只能使用当前受管的本机工作区".into());
    }
    if host.child.try_wait().map_err(|_| "Host state unavailable")?.is_some() {
        return Err("managed Host is not running".into());
    }
    managed_workspace_config(&host.workspace_path)
}
