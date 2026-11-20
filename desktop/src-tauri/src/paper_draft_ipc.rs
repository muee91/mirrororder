//! Fresh PDF draft entry: native selection, internally derived identity, no OCR.
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
        .arg("-m").arg("script_organizer.paper_draft_ipc")
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

fn valid_paper_camera(value: &Value) -> bool {
    matches!(value.as_str(), Some("A" | "B" | "C"))
}

fn valid_hex_digest(value: &Value) -> bool {
    value.as_str().is_some_and(|v| v.len() == 64 && v.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)))
}

fn valid_request(request: &Value) -> bool {
    let Some(obj) = request.as_object() else { return false; };
    let fields: &[&str] = match request["action"].as_str() {
        Some("adopt_registered_preview") => &["action","project_id","binding_id","paper_row_id","expected_paper_revision"],
        Some("source_candidates") => &["action","project_id","paper_row_id","expected_paper_revision"],
        Some("source_bind") => &["action","project_id","header_id","expected_selection_revision","expected_paper_revision","expected_index_sha256","expected_binding_revision","clip_id","media_id"],
        Some("header_context") => &["action","project_id"],
        Some("header_read") => &["action","project_id","header_id","expected_selection_revision","expected_paper_revision"],
        Some("header_select") => &["action","project_id","draft_id","expected_draft_revision","page_index","expected_render_map_id","pixel_rect","expected_selection_revision","expected_paper_revision","paper_row_id","row_digest","card","camera"],
        Some("read") => &["action", "project_id"],
        Some("cell_review_read") => &["action", "project_id", "task_id"],
        Some("reviewed_row") => &["action", "project_id", "task_id", "row_id", "expected_candidate_sha256", "expected_review_revision", "expected_paper_revision", "cells", "column_mapping"],
        Some("select") => &["action", "project_id", "expected_draft_revision"],
        Some("preview_first_page") => &["action", "project_id", "draft_id", "expected_draft_revision"],
        Some("ocr_candidate") | Some("preview_page") | Some("region_read") => &["action", "project_id", "draft_id", "expected_draft_revision", "page_index"],
        Some("region_set") => &["action", "project_id", "draft_id", "expected_draft_revision", "page_index", "expected_region_revision", "expected_render_map_id", "pixel_rect"],
        Some("region_remove") => &["action", "project_id", "draft_id", "expected_draft_revision", "page_index", "expected_region_revision", "expected_render_map_id"],
        _ => return false,
    };
    // Match the Python private consumer's exact two nested-camera shapes.
    // The renderer supplies a cell address selector, not a raw clip code or authority.
    let extended: &[&str] = if obj.contains_key("nested_camera") {
        if !valid_paper_camera(&request["nested_camera"]) || !valid_hex_digest(&request["row_digest"]) { return false; }
        match request["action"].as_str() {
            Some("source_candidates") => &["nested_camera", "row_digest"],
            Some("header_select") if request["nested_camera"] == request["camera"] => &["nested_camera"],
            _ => return false,
        }
    } else { &[] };
    if obj.len() != fields.len() + extended.len()
        || !fields.iter().chain(extended.iter()).all(|key| obj.contains_key(*key))
        || request["project_id"].as_str().map_or(true, |v| v.is_empty()) { return false; }
    if request["action"]=="read" || request["action"]=="header_context" { return true; }
    if request["action"]=="adopt_registered_preview" {
        return request["expected_paper_revision"].as_u64().is_some()
            && valid_hex_digest(&request["binding_id"])
            && request["paper_row_id"].as_str().and_then(|r|r.strip_prefix("paper-row-"))
                .is_some_and(|r| valid_hex_digest(&Value::String(r.to_owned())));
    }
    if request["action"]=="source_candidates" || request["action"]=="source_bind" {
        if request["expected_paper_revision"].as_u64().is_none() {return false;}
        if request["action"]=="source_candidates" {return request["paper_row_id"].as_str().map_or(false,|v|!v.is_empty());}
        return request["expected_binding_revision"].as_u64().is_some() && request["expected_selection_revision"].as_u64().is_some()
            && ["header_id","expected_index_sha256","clip_id","media_id"].iter().all(|k|request[*k].as_str().map_or(false,|v|!v.is_empty()));
    }
    if request["action"]=="header_read" || request["action"]=="header_select" {
        if request["expected_selection_revision"].as_u64().is_none() || request["expected_paper_revision"].as_u64().is_none() {return false;}
        if request["action"]=="header_read" {return request["header_id"].as_str().map_or(false,|v| !v.is_empty());}
        return request["expected_draft_revision"].as_u64().is_some() && request["page_index"].as_u64().is_some()
            && ["draft_id","expected_render_map_id","paper_row_id","row_digest","card","camera"].iter().all(|k|request[*k].as_str().map_or(false,|v|!v.is_empty()))
            && request["pixel_rect"].as_array().map_or(false,|v|v.len()==4 && v.iter().all(|n|n.as_i64().is_some()));
    }
    if request["action"]=="cell_review_read" || request["action"]=="reviewed_row" {
        if request["task_id"].as_str().map_or(true,|v|v.is_empty()) {return false;}
        return request["action"]=="cell_review_read" || (request["expected_review_revision"].as_u64().is_some() && request["expected_paper_revision"].as_u64().is_some() && request["cells"].as_array().is_some() && request["column_mapping"].as_array().is_some());
    }
    if request["expected_draft_revision"].as_u64().is_none() { return false; }
    if request["action"]=="region_set" || request["action"]=="region_remove" {
        if request["expected_region_revision"].as_u64().is_none() || request["expected_render_map_id"].as_str().is_none() {return false;}
        if request["action"]=="region_set" && request["pixel_rect"].as_array().map_or(true,|v| v.len()!=4 || v.iter().any(|n| n.as_i64().is_none())) {return false;}
    }
    request["action"]=="select" || ((request["action"]=="preview_first_page" || request["page_index"].as_u64().is_some()) && request["draft_id"].as_str().map_or(false,|v| v.starts_with("pdf-draft-")))
}

#[tauri::command]
pub async fn paper_pdf_draft(window: WebviewWindow, app: AppHandle,
    manager: State<'_, HostManager>, request: Value) -> Result<Value, String> {
    let url = window.url().map_err(|_| "unable to verify local window origin")?;
    if !trusted_origin(window.label(), url.as_str()) || !valid_request(&request) {
        return Err("paper source preview requires packaged main and a scoped request".into());
    }
    let workspace = scene_interval_workspace(&manager)?;
    if resolve_python_runtime(&app)?.origin != RuntimeOrigin::PackagedResource {
        return Err("paper source preview requires packaged runtime".into());
    }
    let selected = if request["action"] == "select" {
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
        let good=json!({"action":"select","project_id":"p","expected_draft_revision":0});
        assert!(valid_request(&good));
        for key in ["path","selected_path","url","workspace","native_helper","grant","pdf_sha256","page_count","engine"] { let mut bad=good.clone(); bad[key]=json!("anything"); assert!(!valid_request(&bad)); }
    }
    #[test]
    fn header_selection_keeps_native_only_request_boundary() {
        let good=json!({"action":"header_select","project_id":"p","draft_id":"pdf-draft-x","expected_draft_revision":1,"page_index":0,"expected_render_map_id":"map","pixel_rect":[10,20,30,40],"expected_selection_revision":0,"expected_paper_revision":1,"paper_row_id":"row","row_digest":"digest","card":"A001","camera":"A"});
        assert!(valid_request(&good));
        for key in ["path","actor","current_source_verified","pdf_sha256","authority"] {let mut bad=good.clone();bad[key]=json!(true);assert!(!valid_request(&bad));}
        let mut bad=good.clone();bad["expected_selection_revision"]=json!(-1);assert!(!valid_request(&bad));
        bad=good.clone();bad["pixel_rect"]=json!([0,1.5,2,3]);assert!(!valid_request(&bad));
    }
    #[test]
    fn electronic_candidates_and_header_accept_only_typed_cell_selectors() {
        let hash = "a".repeat(64);
        let basic = json!({"action":"source_candidates","project_id":"p","paper_row_id":"row","expected_paper_revision":1});
        assert!(valid_request(&basic));
        let mut candidates = basic.clone();
        candidates["nested_camera"] = json!("A");
        assert!(!valid_request(&candidates));
        candidates["row_digest"] = json!(hash);
        assert!(valid_request(&candidates));
        for (key, value) in [("nested_camera",json!(["A"])),("nested_camera",json!("B002")),("row_digest",json!("wrong")),("expected_paper_revision",json!(-1)),("code",json!("C006")),("raw_cell",json!("/cameras/A/clip_raw")),("path",json!("/tmp/input.json")),("selected_path",json!("/tmp/input.json")),("source_cell_sha256",json!(hash)),("authority",json!(true)),("expected_scope",json!(hash))] {
            let mut bad = candidates.clone(); bad[key] = value; assert!(!valid_request(&bad), "accepted {key}");
        }
        let header = json!({"action":"header_select","project_id":"p","draft_id":"pdf-draft-x","expected_draft_revision":1,"page_index":0,"expected_render_map_id":"map","pixel_rect":[10,20,30,40],"expected_selection_revision":0,"expected_paper_revision":1,"paper_row_id":"row","row_digest":hash,"card":"A001","camera":"A","nested_camera":"A"});
        assert!(valid_request(&header));
        for (key, value) in [("nested_camera",json!("B")),("row_digest",json!(false)),("expected_selection_revision",json!(1.5)),("expected_paper_revision",json!(-1)),("raw_code",json!("C006")),("selected_path",json!("/tmp/file"))] {
            let mut bad=header.clone();bad[key]=value;assert!(!valid_request(&bad), "accepted {key}");
        }
    }
    #[test]
    fn verified_preview_adoption_does_not_accept_a_new_path_or_scope() {
        let request=json!({"action":"adopt_registered_preview","project_id":"p","binding_id":"a".repeat(64),"paper_row_id":format!("paper-row-{}", "b".repeat(64)),"expected_paper_revision":1});
        assert!(valid_request(&request));
        for key in ["path","pdf_sha256","selected_path","workspace","expected_scope","ocr","native_helper"] {
            let mut bad=request.clone();bad[key]=json!("untrusted");assert!(!valid_request(&bad));
        }
        let mut stale=request.clone();stale["expected_paper_revision"]=json!(-1);assert!(!valid_request(&stale));
        let mut raw=request.clone();raw["paper_row_id"]=json!("wrong");assert!(!valid_request(&raw));
    }
    #[test]
    fn source_binding_never_accepts_file_or_code_authority() {
        let good=json!({"action":"source_bind","project_id":"p","header_id":"header","expected_selection_revision":1,"expected_paper_revision":1,"expected_index_sha256":"index","expected_binding_revision":0,"clip_id":"clip","media_id":"media"});
        assert!(valid_request(&good));
        for key in ["path","code","card","camera","actor","workspace","authority","nested_camera","row_digest","source_context_revision"] {let mut bad=good.clone();bad[key]=json!("untrusted");assert!(!valid_request(&bad));}
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
