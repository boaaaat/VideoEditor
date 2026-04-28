use crate::engine_sidecar::EngineSidecar;
use crate::AppState;
use serde_json::Value;
use tauri::State;

pub fn send_engine_request(
    state: State<'_, AppState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    let mut sidecar_guard = state
        .sidecar
        .lock()
        .map_err(|_| "engine sidecar lock poisoned".to_string())?;

    if sidecar_guard.is_none() {
        *sidecar_guard = Some(EngineSidecar::start()?);
    }

    let sidecar = sidecar_guard
        .as_mut()
        .ok_or_else(|| "engine sidecar is not running".to_string())?;

    sidecar.request(&method, params.unwrap_or(Value::Null))
}
