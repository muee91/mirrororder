mod gateway;
mod host;
mod persistence;
mod platform;
mod runtime;
mod service_health;
mod timeline;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_http::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(gateway::GatewayManager::default())
        .manage(host::HostManager::default())
        .manage(timeline::TimelineManager::default())
        .invoke_handler(tauri::generate_handler![
            gateway::start_team_gateway,
            gateway::team_gateway_status,
            gateway::stop_team_gateway,
            host::start_python_host,
            host::host_process_status,
            host::stop_python_host,
            platform::platform_info,
            platform::reveal_path,
            platform::open_path,
            platform::open_url,
            platform::open_in_final_cut_pro,
            timeline::timeline_new,
            timeline::timeline_load,
            timeline::timeline_open_persisted,
            timeline::timeline_load_with_commands,
            timeline::timeline_snapshot,
            timeline::timeline_apply,
            timeline::timeline_apply_batch,
            timeline::timeline_undo,
            timeline::timeline_redo,
            timeline::timeline_checkpoint,
            timeline::timeline_persistence_status,
            timeline::timeline_validate,
        ])
        .run(tauri::generate_context!())
        .expect("error while running MirrorOrder Desktop");
}
