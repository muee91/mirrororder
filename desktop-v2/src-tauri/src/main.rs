mod host;
mod timeline;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(host::HostManager::default())
        .manage(timeline::TimelineManager::default())
        .invoke_handler(tauri::generate_handler![
            host::start_python_host,
            host::host_process_status,
            host::stop_python_host,
            timeline::timeline_new,
            timeline::timeline_load,
            timeline::timeline_snapshot,
            timeline::timeline_apply,
            timeline::timeline_undo,
            timeline::timeline_redo,
            timeline::timeline_validate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MirrorOrder Desktop v2");
}
