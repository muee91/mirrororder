use serde::Serialize;
use std::{path::{Path, PathBuf}, process::Command};

#[derive(Debug, Clone, Serialize)]
pub struct PlatformInfo {
    os: &'static str,
    family: &'static str,
    reveal_path: bool,
    open_path: bool,
    open_url: bool,
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

fn safe_url(value: &str) -> Result<String, String> {
    let value = value.trim();
    if value.starts_with("http://") || value.starts_with("https://") {
        Ok(value.to_string())
    } else {
        Err("只允许打开 http:// 或 https:// URL".to_string())
    }
}

fn fcpxml_path(value: &str) -> Result<PathBuf, String> {
    let path = existing_path(value)?;
    if !path.is_file() || path.extension().and_then(|value| value.to_str()).map(|value| value.eq_ignore_ascii_case("fcpxml")) != Some(true) {
        return Err("Final Cut adapter 只接受现有 .fcpxml 文件".to_string());
    }
    Ok(path)
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

#[cfg(target_os = "macos")]
fn open_url_impl(url: &str) -> Result<(), String> {
    let mut command = Command::new("open");
    command.arg(url);
    run(command, "macOS 打开 URL")
}

#[cfg(target_os = "macos")]
fn final_cut_impl(path: &Path) -> Result<(), String> {
    let mut command = Command::new("open");
    command.arg("-a").arg("Final Cut Pro").arg(path);
    run(command, "Final Cut Pro 打开 FCPXML")
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

#[cfg(target_os = "windows")]
fn open_url_impl(url: &str) -> Result<(), String> {
    let mut command = Command::new("cmd");
    command.arg("/C").arg("start").arg("").arg(url);
    run(command, "Windows 打开 URL")
}

#[cfg(not(target_os = "macos"))]
fn final_cut_impl(_path: &Path) -> Result<(), String> {
    Err("Final Cut Pro adapter 仅在 macOS 可用".to_string())
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

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn open_url_impl(url: &str) -> Result<(), String> {
    let mut command = Command::new("xdg-open");
    command.arg(url);
    run(command, "打开 URL")
}

#[tauri::command]
pub fn platform_info() -> PlatformInfo {
    PlatformInfo {
        os: std::env::consts::OS,
        family: std::env::consts::FAMILY,
        reveal_path: true,
        open_path: true,
        open_url: true,
        native_dialog: true,
        fcp_adapter: cfg!(target_os = "macos"),
        // Tauri Desktop v2 is not App-Sandboxed today. If sandboxing is enabled
        // for distribution, persistent security-scoped bookmarks become a
        // separate native gate and this capability must change only then.
        security_scoped_media: false,
        // Windows NLE adapters intentionally remain extension points in Phase 6.
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

#[tauri::command]
pub fn open_url(url: String) -> Result<(), String> {
    open_url_impl(&safe_url(&url)?)
}

#[tauri::command]
pub fn open_in_final_cut_pro(path: String) -> Result<(), String> {
    final_cut_impl(&fcpxml_path(&path)?)
}

#[cfg(test)]
mod tests {
    use super::{existing_path, fcpxml_path, safe_url};
    use std::{env, fs};

    #[test]
    fn rejects_empty_and_missing_paths() {
        assert!(existing_path("   ").is_err());
        assert!(existing_path("/definitely/mirrororder/not-here").is_err());
    }

    #[test]
    fn accepts_only_http_urls() {
        assert_eq!(safe_url("https://example.com/a").unwrap(), "https://example.com/a");
        assert!(safe_url("file:///tmp/demo").is_err());
        assert!(safe_url("javascript:alert(1)").is_err());
    }

    #[test]
    fn final_cut_adapter_requires_fcpxml_extension() {
        let root = env::temp_dir().join(format!("mirrororder-platform-{}", std::process::id()));
        let _ = fs::create_dir_all(&root);
        let xml = root.join("demo.fcpxml");
        let text = root.join("demo.txt");
        fs::write(&xml, b"<fcpxml/>").unwrap();
        fs::write(&text, b"not fcpxml").unwrap();
        assert!(fcpxml_path(xml.to_str().unwrap()).is_ok());
        assert!(fcpxml_path(text.to_str().unwrap()).is_err());
        let _ = fs::remove_dir_all(root);
    }
}
