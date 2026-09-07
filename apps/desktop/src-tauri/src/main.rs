mod agent_bridge;
mod commands;
mod composition;
mod engine_rpc;
mod engine_sidecar;
mod mcp_discovery;
mod plugins;
mod preview_url;

use engine_sidecar::EngineSidecar;
use std::sync::Mutex;
use tauri::Manager;

pub struct AppState {
    sidecar: Mutex<Option<EngineSidecar>>,
}

impl Default for AppState {
    fn default() -> Self {
        Self {
            sidecar: Mutex::new(None),
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(AppState::default())
        .manage(agent_bridge::AgentBridge::default())
        .setup(|app| {
            agent_bridge::initialize(app.handle());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() == "main" && matches!(event, tauri::WindowEvent::Destroyed) {
                agent_bridge::shutdown(window.app_handle());
            }
        })
        .invoke_handler(tauri::generate_handler![
            agent_bridge::agent_bridge_status,
            agent_bridge::agent_bridge_register_codex,
            agent_bridge::agent_bridge_ready,
            agent_bridge::agent_bridge_set_enabled,
            agent_bridge::agent_bridge_respond,
            plugins::plugins_inspect,
            plugins::plugins_install,
            plugins::plugins_list,
            plugins::plugins_load,
            plugins::plugins_start_script,
            plugins::plugins_stop_script,
            plugins::plugins_set_enabled,
            plugins::plugins_set_developer_mode,
            plugins::plugins_record_result,
            plugins::plugins_remove,
            plugins::plugins_run_native,
            commands::engine_rpc,
            composition::composition_frame,
            composition::composition_cancel,
            commands::engine_status,
            commands::media_probe,
            commands::media_audio_preview_source,
            commands::media_generate_proxy,
            commands::media_proxy_status,
            commands::media_preview_frame_data_url,
            commands::media_thumbnail_data_url,
            commands::media_waveform_data_url,
            commands::preview_attach,
            commands::preview_resize,
            commands::preview_url,
            commands::append_app_log,
            commands::delete_project_folder,
            commands::load_project_snapshot,
            commands::reveal_media_path,
            commands::save_project_snapshot,
            commands::save_subtitle_file,
            commands::validate_media_paths
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Video Editor");
}
