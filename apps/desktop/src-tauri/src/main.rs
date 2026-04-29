mod commands;
mod engine_rpc;
mod engine_sidecar;
mod openai_planner;
mod preview_url;

use engine_sidecar::EngineSidecar;
use std::sync::Mutex;

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
        .invoke_handler(tauri::generate_handler![
            commands::ai_generate_rough_cut_proposal,
            commands::engine_rpc,
            commands::engine_status,
            commands::media_probe,
            commands::media_preview_frame_data_url,
            commands::media_thumbnail_data_url,
            commands::preview_attach,
            commands::preview_resize,
            commands::preview_url
        ])
        .run(tauri::generate_context!())
        .expect("failed to run AI Video Editor");
}
