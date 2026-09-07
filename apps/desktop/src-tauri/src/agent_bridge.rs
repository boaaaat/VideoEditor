use crate::mcp_discovery;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::io::Read;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    mpsc, Arc, Mutex,
};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};
use tiny_http::{Header, Method, Response, Server, StatusCode};
use uuid::Uuid;

#[derive(Default)]
pub struct AgentBridge {
    frontend_ready: AtomicBool,
    running: Mutex<Option<RunningBridge>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    startup_error: Mutex<Option<String>>,
    registration_error: Mutex<Option<String>>,
}

#[tauri::command]
pub fn agent_bridge_ready(state: State<'_, AgentBridge>) {
    state.frontend_ready.store(true, Ordering::SeqCst);
}

struct RunningBridge {
    enabled: Arc<AtomicBool>,
    config_path: PathBuf,
    token: String,
}

fn config_path() -> Result<PathBuf, String> {
    mcp_discovery::bridge_path()
}

fn preference_path() -> Result<PathBuf, String> {
    Ok(config_path()?.with_extension("preferences.json"))
}

pub fn initialize(app: &AppHandle) {
    let state = app.state::<AgentBridge>();
    if let Ok(mut error) = state.registration_error.lock() {
        *error = mcp_discovery::register(app).err();
    }
    let result = (|| -> Result<(), String> {
        let enabled = if std::env::args().any(|arg| arg == "--agent-access") {
            true
        } else {
            match fs::read_to_string(preference_path()?) {
                Ok(text) => serde_json::from_str::<Value>(&text)
                    .map_err(|e| format!("Cannot read agent access preference: {e}"))?
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or("Invalid agent access preference")?,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => return Err(error.to_string()),
            }
        };
        set_runtime_enabled(app.clone(), &state, enabled)?;
        Ok(())
    })();
    if let Ok(mut error) = state.startup_error.lock() {
        *error = result.err();
    };
}

pub fn shutdown(app: &AppHandle) {
    // Closing the window revokes this session without forgetting the user's choice.
    let _ = set_runtime_enabled(app.clone(), &app.state::<AgentBridge>(), false);
}

#[tauri::command]
pub fn agent_bridge_status(app: AppHandle, state: State<'_, AgentBridge>) -> Result<Value, String> {
    let running = state.running.lock().map_err(|error| error.to_string())?;
    let configuration = mcp_discovery::configuration(&app);
    Ok(json!({
        "enabled": running.is_some(), "configPath": config_path()?,
        "serverPath": configuration.as_ref().ok().and_then(|config| config.args.first()),
        "mcpConfig": configuration.as_ref().ok(), "discoveryError": configuration.err(),
        "codex": mcp_discovery::status(&app),
        "startupError": *state.startup_error.lock().map_err(|e| e.to_string())?,
        "registrationError": *state.registration_error.lock().map_err(|e| e.to_string())?
    }))
}

#[tauri::command]
pub fn agent_bridge_register_codex(
    app: AppHandle,
    state: State<'_, AgentBridge>,
) -> Result<Value, String> {
    let result = mcp_discovery::register(&app);
    *state.registration_error.lock().map_err(|e| e.to_string())? = result.as_ref().err().cloned();
    result?;
    agent_bridge_status(app, state)
}

#[tauri::command]
pub fn agent_bridge_set_enabled(
    app: AppHandle,
    state: State<'_, AgentBridge>,
    enabled: bool,
) -> Result<Value, String> {
    let result = set_runtime_enabled(app.clone(), &state, enabled)?;
    mcp_discovery::write_atomic(
        &preference_path()?,
        &json!({ "enabled": enabled }).to_string(),
    )?;
    *state.startup_error.lock().map_err(|e| e.to_string())? = None;
    if enabled {
        *state.registration_error.lock().map_err(|e| e.to_string())? =
            mcp_discovery::register(&app).err();
    }
    Ok(result)
}

fn set_runtime_enabled(
    app: AppHandle,
    state: &AgentBridge,
    enabled: bool,
) -> Result<Value, String> {
    let mut running = state.running.lock().map_err(|error| error.to_string())?;
    if enabled && running.is_some() {
        return Ok(json!({ "enabled": true, "configPath": config_path()? }));
    }
    if let Some(current) = running.take() {
        current.enabled.store(false, Ordering::SeqCst);
        // A newer editor window may have published its own session at this path.
        let owns_file = fs::read_to_string(&current.config_path)
            .ok()
            .and_then(|text| serde_json::from_str::<Value>(&text).ok())
            .is_some_and(|config| config["token"].as_str() == Some(current.token.as_str()));
        if owns_file {
            let _ = fs::remove_file(current.config_path);
        }
        if let Ok(mut pending) = state.pending.lock() {
            for (_, reply) in pending.drain() {
                let _ = reply.send(json!({ "error": "Agent access was disabled" }));
            }
        }
    }
    if !enabled {
        return Ok(json!({ "enabled": false, "configPath": config_path()? }));
    }
    let server = Server::http(("127.0.0.1", 0)).map_err(|error| error.to_string())?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or("No local bridge address")?;
    let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
    let path = config_path()?;
    fs::create_dir_all(path.parent().ok_or("Invalid bridge configuration path")?)
        .map_err(|error| error.to_string())?;
    let config = json!({ "url": format!("http://{address}/rpc"), "token": token, "pid": std::process::id() });
    mcp_discovery::write_atomic(&path, &config.to_string())?;
    let active = Arc::new(AtomicBool::new(true));
    *running = Some(RunningBridge {
        enabled: active.clone(),
        config_path: path.clone(),
        token: token.clone(),
    });
    std::thread::spawn(move || serve(app, server, active, token, address.to_string()));
    Ok(json!({ "enabled": true, "configPath": path }))
}

#[tauri::command]
pub fn agent_bridge_respond(
    state: State<'_, AgentBridge>,
    request_id: String,
    response: Value,
) -> Result<(), String> {
    let reply = state
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&request_id);
    if let Some(reply) = reply {
        let _ = reply.send(response);
    }
    Ok(())
}

fn allowed_method(method: &str) -> bool {
    matches!(
        method,
        "editor.state"
            | "project.create"
            | "project.open"
            | "project.save"
            | "project.settings"
            | "command.execute"
            | "command.undo"
            | "command.redo"
            | "command.history"
            | "media.probe"
            | "media.index"
            | "media.check"
            | "media.frame"
            | "timeline.state"
            | "timeline.frame"
            | "subtitles.import"
            | "subtitles.export"
            | "editor.playback"
            | "export.start"
            | "export.status"
            | "export.cancel"
            | "ai.proposals"
            | "ai.proposal.create"
            | "ai.proposal.apply"
            | "ai.proposal.reject"
            | "plugin.list"
            | "plugin.inspect"
            | "plugin.install"
            | "plugin.enable"
            | "plugin.remove"
            | "plugin.developer_mode"
            | "plugin.run"
    )
}

fn serve(app: AppHandle, server: Server, active: Arc<AtomicBool>, token: String, address: String) {
    while active.load(Ordering::SeqCst) {
        let Ok(Some(mut request)) = server.recv_timeout(Duration::from_millis(200)) else {
            continue;
        };
        let header = |name: &'static str| {
            request
                .headers()
                .iter()
                .find(|item| item.field.equiv(name))
                .map(|item| item.value.as_str())
        };
        let authenticated = header("Authorization") == Some(format!("Bearer {token}").as_str());
        let local = request
            .remote_addr()
            .map(|peer| peer.ip().is_loopback())
            .unwrap_or(false);
        if !local
            || !authenticated
            || header("Origin").is_some()
            || header("Host") != Some(address.as_str())
        {
            let _ = request.respond(Response::empty(StatusCode(403)));
            continue;
        }
        if request.method() != &Method::Post || request.url() != "/rpc" {
            let _ = request.respond(Response::empty(StatusCode(404)));
            continue;
        }
        if !app
            .state::<AgentBridge>()
            .frontend_ready
            .load(Ordering::SeqCst)
        {
            let _ = request.respond(
                Response::from_string("Editor is still starting. Retry when the window is ready.")
                    .with_status_code(StatusCode(503)),
            );
            continue;
        }
        const MAX_BODY: usize = 2 * 1024 * 1024;
        if request.body_length().is_none_or(|size| size > MAX_BODY) {
            let _ = request.respond(Response::empty(StatusCode(413)));
            continue;
        }
        let mut body = String::new();
        if request
            .as_reader()
            .take((MAX_BODY + 1) as u64)
            .read_to_string(&mut body)
            .is_err()
            || body.len() > MAX_BODY
        {
            let _ = request.respond(Response::empty(StatusCode(400)));
            continue;
        }
        let response = match serde_json::from_str::<Value>(&body) {
            Ok(value)
                if value
                    .get("method")
                    .and_then(Value::as_str)
                    .is_some_and(allowed_method) =>
            {
                let id = Uuid::new_v4().to_string();
                let (sender, receiver) = mpsc::channel();
                let bridge = app.state::<AgentBridge>();
                if let Ok(mut pending) = bridge.pending.lock() {
                    pending.insert(id.clone(), sender);
                }
                let emitted = app.emit("agent:request", json!({ "requestId": id, "method": value["method"], "params": value.get("params").cloned().unwrap_or(json!({})) }));
                let result = if emitted.is_ok() {
                    receiver.recv_timeout(Duration::from_secs(120)).unwrap_or_else(|_| json!({ "error": "Editor did not respond. The result is uncertain; inspect state before retrying a mutation." }))
                } else {
                    json!({ "error": "Editor is unavailable" })
                };
                if let Ok(mut pending) = bridge.pending.lock() {
                    pending.remove(&id);
                }
                result
            }
            _ => json!({ "error": "Invalid or unsupported editor request" }),
        };
        let mut reply = Response::from_string(response.to_string());
        if let Ok(header) = Header::from_bytes("Content-Type", "application/json") {
            reply.add_header(header);
        }
        let _ = request.respond(reply);
    }
}

#[cfg(test)]
mod tests {
    use super::allowed_method;
    #[test]
    fn bridge_only_exposes_editor_operations() {
        assert!(allowed_method("command.execute"));
        assert!(allowed_method("editor.state"));
        assert!(!allowed_method("project.reset"));
        assert!(!allowed_method("delete_project_folder"));
        assert!(!allowed_method("engine_rpc"));
    }
}
