//! Native-owned PDF selection and opaque registered preview. No HTTP path grant.
use crate::host::{scene_interval_workspace, HostManager};
use crate::runtime::{resolve_python_runtime, packaged_python_home, python_path_with_source, path_with_tools, RuntimeOrigin};
use serde_json::{Value, json};
use tauri_plugin_dialog::DialogExt;
use tauri::path::BaseDirectory;
use std::{io::{Read, Write}, process::{Command, Stdio}, thread, time::{Duration, Instant}, path::PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};

fn trusted_origin(label: &str, url: &str) -> bool {
    if label != "main" { return false; }
    let base = url.split('#').next().unwrap_or("");
    ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
        .iter().any(|origin| ["", "/", "/index.html"].iter().any(|path| base == format!("{origin}{path}")))
}

fn run_consumer(app: AppHandle, workspace: PathBuf, request: Value, selected: Option<PathBuf>) -> Result<Value, String> {
    let bytes = serde_json::to_vec(&json!({"request":request,"selected_path":selected})).map_err(|_| "invalid paper source request")?;
    if bytes.len() > 16384 { return Err("paper source request too large".into()); }
    let runtime = resolve_python_runtime(&app)?;
    if runtime.origin != RuntimeOrigin::PackagedResource {
        return Err("paper source confirmation requires the packaged local runtime".into());
    }
    let helper = app.path().resolve("native/paper-pdf-render", BaseDirectory::Resource).map_err(|_| "native PDF helper unavailable")?;
    let data_dir = app.path().app_data_dir().map_err(|_| "local app data unavailable")?;
    let mut command = Command::new(&runtime.python_executable);
    command.current_dir(&runtime.core_root)
        .env("PYTHONPATH", python_path_with_source(&runtime.source_dir)?)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("MIRRORORDER_PACKAGED_RUNTIME", "1")
        .env("MIRRORORDER_DATA_DIR", &data_dir)
        .env("MIRRORORDER_DEVICE_STATE_DIR", &data_dir)
        .arg("-m").arg("script_organizer.paper_preview_ipc")
        .arg("--workspace").arg(workspace).arg("--native-helper").arg(helper)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(home) = packaged_python_home(&runtime) { command.env("PYTHONHOME", home); }
    if let Some(path) = path_with_tools(runtime.tool_bin.as_deref())? { command.env("PATH", path); }
    let mut child = command.spawn().map_err(|_| "paper source helper failed to start")?;
    let mut input = child.stdin.take().ok_or("paper source helper input unavailable")?;
    if input.write_all(&bytes).is_err() { let _ = child.kill(); let _ = child.wait(); return Err("paper source helper input failed".into()); }
    drop(input);
    let output = child.stdout.take().ok_or("paper source helper output unavailable")?;
    let reader = thread::spawn(move || { let mut data = Vec::new(); output.take(12_582_913).read_to_end(&mut data).map(|_| data) });
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        match child.try_wait() {
            Ok(Some(status)) => {
                let data = reader.join().map_err(|_| "paper source helper output failed")?.map_err(|_| "paper source helper output failed")?;
                if !status.success() || data.len() > 12_582_912 { return Err("paper source helper failed; re-read evidence before retry".into()); }
                return serde_json::from_slice(&data).map_err(|_| "invalid paper source helper response".into());
            },
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => { let _ = child.kill(); let _ = child.wait(); let _ = reader.join(); return Err("paper source helper interrupted; outcome must be re-read".into()); }
        }
    }
}

fn valid_request(request: &Value) -> bool {
    let Some(obj) = request.as_object() else { return false; };
    let fields: &[&str] = match request["action"].as_str() {
        Some("register") => &["action", "project_id", "document_id", "expected_paper_revision", "expected_document_digest", "page_index"],
        Some("preview") => &["action", "project_id", "geometry_id"],
        Some("discover") => &["action", "project_id", "paper_row_id"],
        Some("preview_page") => &["action", "project_id", "binding_id", "paper_row_id"],
        _ => return false,
    };
    if obj.len() != fields.len() || !fields.iter().all(|key| obj.contains_key(*key)) { return false; }
    if request["project_id"].as_str().map_or(true, |v| v.is_empty()) { return false; }
    if request["action"] == "register" {
        request["expected_paper_revision"].as_u64().is_some() && request["page_index"].as_u64().is_some()
          && request["expected_document_digest"].as_str().map_or(false, |v| v.len() == 64)
          && request["document_id"].as_str().map_or(false, |v| !v.is_empty())
    } else if request["action"] == "discover" { request["paper_row_id"].as_str().map_or(false, |v| !v.is_empty())
    } else if request["action"] == "preview_page" {
        request["binding_id"].as_str().map_or(false, |v| v.len() == 64) && request["paper_row_id"].as_str().map_or(false, |v| !v.is_empty())
    } else { request["geometry_id"].as_str().map_or(false, |v| v.len() == 64) }
}

#[tauri::command]
pub async fn paper_source_preview(window: WebviewWindow, app: AppHandle,
    manager: State<'_, HostManager>, request: Value) -> Result<Value, String> {
    let url = window.url().map_err(|_| "unable to verify local window origin")?;
    if !trusted_origin(window.label(), url.as_str()) || !valid_request(&request) {
        return Err("paper source preview requires packaged main and a scoped request".into());
    }
    let workspace = scene_interval_workspace(&manager)?;
    if resolve_python_runtime(&app)?.origin != RuntimeOrigin::PackagedResource {
        return Err("paper source preview requires packaged runtime".into());
    }
    let selected = if request["action"] == "register" {
        let helper = app.path().resolve("native/paper-pdf-render", BaseDirectory::Resource).map_err(|_| "native PDF helper missing")?;
        if !helper.is_file() || std::fs::symlink_metadata(&helper).map_err(|_| "native helper unavailable")?.file_type().is_symlink() { return Err("native PDF helper not packaged".into()); }
        let picker_app = app.clone();
        let selected = tauri::async_runtime::spawn_blocking(move || {
            picker_app.dialog().file().add_filter("Original PDF", &["pdf"]).blocking_pick_file()
        }).await.map_err(|_| "native picker failed")?;
        match selected {
            None => return Ok(json!({"ok":true,"data":{"status":"cancelled"}})),
            Some(path) => Some(path.into_path().map_err(|_| "local PDF path unavailable")?),
        }
    } else { None };
    // Do not carry a selection across an active workspace switch.
    if scene_interval_workspace(&manager)? != workspace { return Err("workspace changed during selection".into()); }
    tauri::async_runtime::spawn_blocking(move || run_consumer(app, workspace, request, selected))
        .await.map_err(|_| "paper source helper task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::{trusted_origin, valid_request};
    use serde_json::json;
    #[test]
    fn no_renderer_path_or_grant_fields() {
        let good=json!({"action":"preview","project_id":"p","geometry_id":"a".repeat(64)});
        assert!(valid_request(&good));
        for key in ["path","selected_path","url","workspace","native_helper","grant"] { let mut bad=good.clone(); bad[key]=json!("anything"); assert!(!valid_request(&bad)); }
    }
    #[test]
    fn only_local_packaged_main_is_accepted() {
        assert!(trusted_origin("main", "tauri://localhost/"));
        assert!(trusted_origin("main", "http://tauri.localhost/index.html#slate"));
        for url in ["http://127.0.0.1:8000/", "http://localhost:5173/", "https://example.com/", "tauri://localhost.evil/", "tauri://localhost/?relay=1", "file:///tmp/page.html"] {
            assert!(!trusted_origin("main", url));
        }
        assert!(!trusted_origin("other", "tauri://localhost/"));
    }
}
