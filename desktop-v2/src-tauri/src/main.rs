mod host;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .manage(host::HostManager::default())
        .invoke_handler(tauri::generate_handler![
            host::start_python_host,
            host::host_process_status,
            host::stop_python_host,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MirrorOrder Desktop v2");
}
