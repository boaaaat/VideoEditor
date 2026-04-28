use crate::engine_rpc::send_engine_request;
use crate::preview_url::default_preview_url;
use crate::AppState;
use serde_json::Value;
use tauri::State;

#[tauri::command]
pub fn preview_url() -> String {
    default_preview_url()
}

#[tauri::command]
pub fn engine_status(state: State<'_, AppState>) -> Result<Value, String> {
    send_engine_request(state, "engine.status".to_string(), None)
}

#[tauri::command]
pub fn engine_rpc(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    send_engine_request(state, method, params)
}
