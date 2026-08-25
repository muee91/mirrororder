mod gateway;
mod host;
mod persistence;
mod platform;
mod runtime;
mod service_health;
mod timeline;

use tauri::Manager;

fn main() {
    let app = tauri::Builder::default()
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
        .build(tauri::generate_context!())
        .expect("error while building MirrorOrder Desktop");

    app.run(|app_handle, event| {
        if should_shutdown_managed_services(&event) {
            let _ = host::shutdown(&app_handle.state::<host::HostManager>());
            let _ = gateway::shutdown(&app_handle.state::<gateway::GatewayManager>());
        }
    });
}

fn should_shutdown_managed_services(event: &tauri::RunEvent) -> bool {
    matches!(event, tauri::RunEvent::ExitRequested { .. } | tauri::RunEvent::Exit)
}

#[cfg(test)]
mod tests {
    use super::should_shutdown_managed_services;

    #[test]
    fn final_exit_event_also_triggers_managed_service_shutdown() {
        assert!(should_shutdown_managed_services(&tauri::RunEvent::Exit));
    }
}
