use serde::Serialize;
use std::{path::{Path, PathBuf}, process::Command};

#[derive(Debug, Clone, Serialize)]
pub struct PlatformInfo {
    os: &'static str,
    family: &'static str,
    reveal_path: bool,
    open_path: bool,
    native_dialog: bool,
    fcp_adapter: bool,
    security_scoped_media: bool,
    resolve_adapter: bool,
    premiere_adapter: bool,
}

fn existing_path(value: &str) -> Result<PathBuf, String> {
    let value = value.trim();
    if value.is_empty() {
        return Err("path 不能为空".to_string());
    }
    let path = PathBuf::from(value);
    if !path.exists() {
        return Err(format!("路径不存在：{}", path.display()));
    }
    Ok(path.canonicalize().unwrap_or(path))
}

fn run(mut command: Command, action: &str) -> Result<(), String> {
    let status = command
        .status()
        .map_err(|error| format!("{action} 启动失败：{error}"))?;
    if status.success() {
        Ok(())
    } else {
        Err(format!("{action} 失败：exit {}", status.code().unwrap_or(-1)))
    }
}

#[cfg(target_os = "macos")]
fn reveal_impl(path: &Path) -> Result<(), String> {
    if path.is_dir() {
        let mut command = Command::new("open");
        command.arg(path);
        run(command, "Finder 打开目录")
    } else {
        let mut command = Command::new("open");
        command.arg("-R").arg(path);
        run(command, "Finder 显示文件")
    }
}

#[cfg(target_os = "macos")]
fn open_impl(path: &Path) -> Result<(), String> {
    let mut command = Command::new("open");
    command.arg(path);
    run(command, "macOS 打开路径")
}

#[cfg(target_os = "windows")]
fn reveal_impl(path: &Path) -> Result<(), String> {
    let mut command = Command::new("explorer.exe");
    if path.is_dir() {
        command.arg(path);
    } else {
        command.arg(format!("/select,{}", path.display()));
    }
    run(command, "Explorer 显示路径")
}

#[cfg(target_os = "windows")]
fn open_impl(path: &Path) -> Result<(), String> {
    let mut command = Command::new("explorer.exe");
    command.arg(path);
    run(command, "Windows 打开路径")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn reveal_impl(path: &Path) -> Result<(), String> {
    let target = if path.is_dir() { path } else { path.parent().unwrap_or(path) };
    let mut command = Command::new("xdg-open");
    command.arg(target);
    run(command, "文件管理器打开路径")
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_impl(path: &Path) -> Result<(), String> {
    let mut command = Command::new("xdg-open");
    command.arg(path);
    run(command, "打开路径")
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        family: std::env::consts::FAMILY,
        reveal_path: true,
        open_path: true,
        native_dialog: true,
        fcp_adapter: cfg!(target_os = "macos"),
        // The adapter boundary exists, but scoped-bookmark persistence is a
        // separate macOS native gate and must not be claimed before it lands.
        security_scoped_media: false,
        // Phase 6 keeps extension points for Windows NLEs without pretending
        // Resolve/Premiere integration already exists.
        resolve_adapter: false,
        premiere_adapter: false,
    }
}

#[tauri::command]
pub fn reveal_path(path: String) -> Result<(), String> {
    reveal_impl(&existing_path(&path)?)
}

#[tauri::command]
pub fn open_path(path: String) -> Result<(), String> {
    open_impl(&existing_path(&path)?)
}

#[cfg(test)]
mod tests {
    use super::existing_path;

    #[test]
    fn rejects_empty_and_missing_paths() {
        assert!(existing_path("   ").is_err());
        assert!(existing_path("/definitely/mirrororder/not-here").is_err());
    }
}
