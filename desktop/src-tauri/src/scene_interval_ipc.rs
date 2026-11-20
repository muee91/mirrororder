//! Dedicated packaged-main local confirmation path; no renderer credentials.
use crate::host::{trusted_interval_workspace, HostManager};
use crate::runtime::{resolve_python_runtime, packaged_python_home, python_path_with_source, path_with_tools, RuntimeOrigin};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Arc, Mutex, OnceLock, atomic::{AtomicBool, Ordering}};

type ThumbnailJob = Arc<AtomicBool>;
#[derive(Default)]
struct ThumbnailJobs { active:HashMap<String,ThumbnailJob>, cancelled:HashMap<String,Instant> }
fn thumb_jobs()->&'static Mutex<ThumbnailJobs>{
    static JOBS:OnceLock<Mutex<ThumbnailJobs>>=OnceLock::new();
    JOBS.get_or_init(||Mutex::new(ThumbnailJobs::default()))
}
fn thumb_id(id:&str)->bool{id.len()==32&&id.bytes().all(|c|c.is_ascii_digit()||(b'a'..=b'f').contains(&c))}
fn claim_thumbnail(id:&str)->Result<ThumbnailJob,String>{
    let mut jobs=thumb_jobs().lock().map_err(|_|"thumbnail unavailable")?;
    jobs.cancelled.retain(|_,at|at.elapsed()<Duration::from_secs(10));
    if jobs.cancelled.remove(id).is_some()||jobs.active.contains_key(id)||jobs.active.len()>=2{return Err("thumbnail cancelled or busy".into())}
    let flag=Arc::new(AtomicBool::new(false));jobs.active.insert(id.into(),flag.clone());Ok(flag)
}
fn stop_child(child:&mut std::process::Child, thumbnail:bool){
    #[cfg(unix)]
    if thumbnail{
        // Only a process group newly created for this exact helper; this
        // also terminates FFmpeg, never the existing Host or a player.
        unsafe extern "C" { fn kill(pid:i32, sig:i32)->i32; }
        unsafe { let _=kill(-(child.id() as i32),9); }
    }
    let _=child.kill();
    let _=child.wait();
}
#[tauri::command]
pub fn slate_thumbnail_cancel(window:WebviewWindow,manager:State<'_,HostManager>,request_id:String,expected_managed_base:String)->Result<(),String>{
    let url=window.url().map_err(|_|"thumbnail unavailable")?;
    if !trusted_origin(window.label(),url.as_str())||!thumb_id(&request_id){return Err("invalid thumbnail cancellation".into())}
    trusted_interval_workspace(&manager,Some(&expected_managed_base))?;
    let mut jobs=thumb_jobs().lock().map_err(|_|"thumbnail unavailable")?;
    if let Some(active)=jobs.active.get(&request_id){active.store(true,Ordering::Relaxed);}
    else{
        jobs.cancelled.retain(|_,at|at.elapsed()<Duration::from_secs(10));
        if jobs.cancelled.len()<64{jobs.cancelled.insert(request_id,Instant::now());}
    }
    Ok(())
}

use std::{io::{Read, Write}, process::{Command, Stdio}, thread, time::{Duration, Instant}, path::PathBuf};
use tauri::{AppHandle, Manager, State, WebviewWindow};

fn trusted_origin(label: &str, url: &str) -> bool {
    if label != "main" { return false; }
    let base = url.split('#').next().unwrap_or("");
    ["tauri://localhost", "http://tauri.localhost", "https://tauri.localhost"]
        .iter().any(|origin| ["", "/", "/index.html"].iter().any(|path| base == format!("{origin}{path}")))
}

fn run_consumer(app: AppHandle, workspace: PathBuf, request: Value, thumbnail_job:Option<ThumbnailJob>) -> Result<Value, String> {
    let action = request.get("action").and_then(Value::as_str).unwrap_or("");
    let input_limit = if action == "board_paper_ingest" {4_194_304} else {8192};
    let output_limit = if action == "board_paper_read" {4_194_304} else {1_048_576};
    let bytes = serde_json::to_vec(&request).map_err(|_| "invalid interval request")?;
    if bytes.len() > input_limit { return Err("interval request too large".into()); }
    let runtime = resolve_python_runtime(&app)?;
    if runtime.origin != RuntimeOrigin::PackagedResource {
        return Err("interval confirmation requires the packaged local runtime".into());
    }
    let data_dir = app.path().app_data_dir().map_err(|_| "local app data unavailable")?;
    let mut command = Command::new(&runtime.python_executable);
    command.current_dir(&runtime.core_root)
        .env("PYTHONPATH", python_path_with_source(&runtime.source_dir)?)
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("MIRRORORDER_PACKAGED_RUNTIME", "1")
        .env("MIRRORORDER_DATA_DIR", &data_dir)
        .env("MIRRORORDER_DEVICE_STATE_DIR", &data_dir)
        .arg("-m").arg("script_organizer.scene_interval_ipc")
        .arg("--workspace").arg(workspace)
        .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
    if let Some(home) = packaged_python_home(&runtime) { command.env("PYTHONHOME", home); }
    if let Some(path) = path_with_tools(runtime.tool_bin.as_deref())? { command.env("PATH", path); }
    if thumbnail_job.is_some(){
        #[cfg(not(unix))]
        return Err("thumbnail generation unavailable on this host".into());
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            command.process_group(0);
            let encoder=runtime.tool_bin.as_ref().ok_or("packaged thumbnail encoder unavailable")?.join("ffmpeg");
            if !encoder.is_file(){return Err("packaged thumbnail encoder unavailable".into());}
            command.env("MIRRORORDER_SLATE_THUMBNAIL_FFMPEG",encoder);
        }
    }
    let mut child = command.spawn().map_err(|_| "interval helper failed to start")?;
    let deadline = Instant::now() + Duration::from_secs(8);
    let (Some(mut input), Some(output))=(child.stdin.take(),child.stdout.take()) else {
        stop_child(&mut child,thumbnail_job.is_some());return Err("interval helper pipes unavailable".into());
    };
    let writer=thread::spawn(move || input.write_all(&bytes));
    let reader = thread::spawn(move || { let mut data = Vec::new(); output.take((output_limit + 1) as u64).read_to_end(&mut data).map(|_| data) });
    loop {
        if thumbnail_job.as_ref().is_some_and(|job|job.load(Ordering::Relaxed)){
            stop_child(&mut child,true);let _=writer.join();let _=reader.join();return Err("thumbnail cancelled".into());
        }
        match child.try_wait() {
            Ok(Some(status)) => {
                writer.join().map_err(|_| "interval helper input failed")?.map_err(|_| "interval helper input failed")?;
                let data = reader.join().map_err(|_| "interval helper output failed")?.map_err(|_| "interval helper output failed")?;
                if !status.success() || data.len() > output_limit { return Err("interval helper failed; re-read evidence before retry".into()); }
                return serde_json::from_slice(&data).map_err(|_| "invalid interval helper response".into());
            },
            Ok(None) if Instant::now() < deadline => thread::sleep(Duration::from_millis(20)),
            _ => { stop_child(&mut child,thumbnail_job.is_some()); let _ = writer.join(); let _ = reader.join(); return Err("interval helper interrupted; outcome must be re-read".into()); }
        }
    }
}

#[tauri::command]
pub async fn scene_interval_review(window: WebviewWindow, app: AppHandle,
    manager: State<'_, HostManager>, mut request: Value) -> Result<Value, String> {
    let url = window.url().map_err(|_| "unable to verify local window origin")?;
    if !trusted_origin(window.label(), url.as_str()) { return Err("interval review is restricted to the packaged main window".into()); }
    let action=request.get("action").and_then(Value::as_str).unwrap_or("").to_owned();
    let owner = if action.starts_with("board_") {
        Some(request.as_object_mut().and_then(|r|r.remove("expected_managed_base"))
            .and_then(|v| v.as_str().map(str::to_owned))
            .ok_or("电子场记板缺少受管工作区身份")?)
    } else { None };
    if matches!(action.as_str(), "board_stage"|"board_approve") &&
        request.get("expected_scope").and_then(Value::as_str).is_none() {
        return Err("电子场记板证据版本已变化，请重新核对".into());
    }
    let workspace = trusted_interval_workspace(&manager,owner.as_deref())?;
    let id=if action=="board_slate_thumbnail"{
        Some(request.get("request_id").and_then(Value::as_str).filter(|id|thumb_id(id)).ok_or("invalid thumbnail request")?.to_owned())
    }else{None};
    let flag=id.as_ref().map(|id|claim_thumbnail(id)).transpose()?;
    let joined=tauri::async_runtime::spawn_blocking(move || run_consumer(app, workspace, request,flag)).await;
    if let Some(id)=id{if let Ok(mut jobs)=thumb_jobs().lock(){jobs.active.remove(&id);}}
    joined.map_err(|_| "interval helper task failed".to_string())?
}

#[cfg(test)]
mod tests {
    use super::trusted_origin;
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
