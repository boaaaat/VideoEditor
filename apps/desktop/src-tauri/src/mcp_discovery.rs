use serde::Serialize;
use std::collections::BTreeMap;
use std::fs;
use std::io::ErrorKind;
use std::path::{Path, PathBuf};
use tauri::{AppHandle, Manager};
use toml_edit::{value, Array, DocumentMut, Item, Table};

const SERVER_NAME: &str = "video-editor";

#[derive(Serialize)]
pub struct McpConfiguration {
    command: String,
    pub args: Vec<String>,
    env: BTreeMap<String, String>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CodexStatus {
    registered: bool,
    enabled: bool,
    config_path: Option<PathBuf>,
    error: Option<String>,
}

pub fn bridge_path() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("AI_VIDEO_EDITOR_BRIDGE_FILE").filter(|v| !v.is_empty()) {
        let path = PathBuf::from(path);
        if !path.is_absolute() {
            return Err("AI_VIDEO_EDITOR_BRIDGE_FILE must be an absolute path".into());
        }
        return Ok(path);
    }
    let base = std::env::var_os("LOCALAPPDATA").ok_or("LOCALAPPDATA is unavailable")?;
    Ok(PathBuf::from(base)
        .join("AI Video Editor")
        .join("agent-bridge.json"))
}

fn codex_path(app: &AppHandle) -> Result<PathBuf, String> {
    let home = match std::env::var_os("CODEX_HOME").filter(|v| !v.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => app
            .path()
            .home_dir()
            .map_err(|e| e.to_string())?
            .join(".codex"),
    };
    if !home.is_absolute() {
        return Err("CODEX_HOME must be an absolute path".into());
    }
    Ok(home.join("config.toml"))
}

pub fn configuration(app: &AppHandle) -> Result<McpConfiguration, String> {
    let manifest = PathBuf::from(env!("CARGO_MANIFEST_DIR"));
    let mut candidates = Vec::new();
    if cfg!(debug_assertions) {
        if let Some(root) = manifest.ancestors().nth(3) {
            candidates.push(root.join("packages/mcp/src/index.mjs"));
        }
    }
    if let Ok(resources) = app.path().resource_dir() {
        candidates.push(resources.join("mcp/server.mjs"));
    }
    candidates.push(manifest.join("resources/mcp/server.mjs"));
    let script = candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("MCP server is missing. Run corepack pnpm mcp:build, or reinstall the editor.")?;
    let executable = if cfg!(windows) { "node.exe" } else { "node" };
    let mut runtimes = vec![script.with_file_name(executable)];
    if let Some(search_path) = std::env::var_os("PATH") {
        runtimes.extend(
            std::env::split_paths(&search_path)
                .filter(|path| path.is_absolute())
                .map(|path| path.join(executable)),
        );
    }
    for variable in ["ProgramW6432", "ProgramFiles", "LOCALAPPDATA"] {
        if let Some(base) = std::env::var_os(variable) {
            runtimes.push(PathBuf::from(base).join("nodejs").join(executable));
        }
    }
    runtimes.push(manifest.join("resources/mcp").join(executable));
    let node = runtimes
        .into_iter()
        .find(|path| path.is_file())
        .ok_or("Node.js was not found. Install Node.js 20+ or reinstall the editor.")?;
    Ok(McpConfiguration {
        // Tauri resource paths can use Windows' verbatim prefix. Node's main
        // module resolver fails on those paths even though the files exist.
        command: dunce::simplified(&node).to_string_lossy().into_owned(),
        args: vec![dunce::simplified(&script).to_string_lossy().into_owned()],
        env: BTreeMap::from([(
            "AI_VIDEO_EDITOR_BRIDGE_FILE".into(),
            dunce::simplified(&bridge_path()?)
                .to_string_lossy()
                .into_owned(),
        )]),
    })
}

fn read_optional(path: &Path) -> Result<String, String> {
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

pub fn write_atomic(path: &Path, contents: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Invalid configuration path")?;
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let result = fs::write(&temporary, contents).and_then(|_| fs::rename(&temporary, path));
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|e| format!("Cannot save {}: {e}", path.display()))
}

fn server_matches(server: &Item, config: &McpConfiguration) -> bool {
    server.get("command").and_then(Item::as_str) == Some(config.command.as_str())
        && server
            .get("args")
            .and_then(Item::as_array)
            .is_some_and(|args| {
                args.len() == 1
                    && args.get(0).and_then(toml_edit::Value::as_str)
                        == Some(config.args[0].as_str())
            })
        && server
            .get("env")
            .and_then(|env| env.get("AI_VIDEO_EDITOR_BRIDGE_FILE"))
            .and_then(Item::as_str)
            == Some(config.env["AI_VIDEO_EDITOR_BRIDGE_FILE"].as_str())
        && server.get("url").is_none()
}

fn editor_server(server: &Item) -> bool {
    server.get("url").is_none()
        && server
            .get("args")
            .and_then(Item::as_array)
            .is_some_and(|args| {
                args.len() == 1
                    && args
                        .get(0)
                        .and_then(toml_edit::Value::as_str)
                        .is_some_and(|arg| {
                            let path = arg.replace('\\', "/");
                            path.ends_with("/packages/mcp/src/index.mjs")
                                || path.ends_with("/mcp/server.mjs")
                        })
            })
}

pub fn register(app: &AppHandle) -> Result<(), String> {
    let config = configuration(app)?;
    let path = codex_path(app)?;
    let original = read_optional(&path)?;
    let mut document = original
        .parse::<DocumentMut>()
        .map_err(|e| format!("Invalid Codex configuration: {e}"))?;
    if document.get("mcp_servers").is_none() {
        document["mcp_servers"] = Item::Table(Table::new());
    }
    let servers = document["mcp_servers"]
        .as_table_like_mut()
        .ok_or("Codex mcp_servers must be a table")?;
    if let Some(server) = servers.get(SERVER_NAME) {
        if !editor_server(server) {
            return Err("Codex already has a different server named video-editor. Rename that entry in Codex settings, then retry registration.".into());
        }
    } else {
        servers.insert(SERVER_NAME, Item::Table(Table::new()));
    }
    let server = servers
        .get_mut(SERVER_NAME)
        .and_then(Item::as_table_like_mut)
        .ok_or("Invalid video-editor MCP entry")?;
    server.insert("command", value(config.command.as_str()));
    let mut args = Array::new();
    args.push(config.args[0].as_str());
    server.insert("args", value(args));
    // Preserve explicit disabling, timeouts, tool policies, and other user settings.
    if !server.contains_key("startup_timeout_sec") {
        server.insert("startup_timeout_sec", value(20));
    }
    if !server.contains_key("tool_timeout_sec") {
        server.insert("tool_timeout_sec", value(180));
    }
    if !server.contains_key("env") {
        server.insert("env", Item::Table(Table::new()));
    }
    let env = server
        .get_mut("env")
        .and_then(Item::as_table_like_mut)
        .ok_or("Invalid video-editor environment table")?;
    env.insert(
        "AI_VIDEO_EDITOR_BRIDGE_FILE",
        value(config.env["AI_VIDEO_EDITOR_BRIDGE_FILE"].as_str()),
    );
    let updated = document.to_string();
    if updated != original {
        if read_optional(&path)? != original {
            return Err(
                "Codex configuration changed during registration. Retry registration.".into(),
            );
        }
        write_atomic(&path, &updated)?;
    }
    Ok(())
}

pub fn status(app: &AppHandle) -> CodexStatus {
    let mut status = CodexStatus::default();
    let result = (|| -> Result<(), String> {
        let path = codex_path(app)?;
        status.config_path = Some(path.clone());
        let config = configuration(app)?;
        let document = read_optional(&path)?
            .parse::<DocumentMut>()
            .map_err(|e| format!("Invalid Codex configuration: {e}"))?;
        if let Some(server) = document
            .get("mcp_servers")
            .and_then(|servers| servers.get(SERVER_NAME))
        {
            status.registered = server_matches(server, &config);
            status.enabled =
                status.registered && server.get("enabled").and_then(Item::as_bool) != Some(false);
        }
        Ok(())
    })();
    status.error = result.err();
    status
}
