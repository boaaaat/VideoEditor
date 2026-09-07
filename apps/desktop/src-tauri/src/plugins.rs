use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock,
};
use std::{
    env, fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::Mutex,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tiny_http::{Header, Response, Server};

static STORE_LOCK: Mutex<()> = Mutex::new(());
static SCRIPT_SERVERS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
const MAX_PACKAGE_BYTES: u64 = 64 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 2 * 1024 * 1024;
const STATE_FILE: &str = ".editor-plugin-state.json";

const SCRIPT_BOOTSTRAP: &str = r#"
const nonce=location.pathname.split('/')[1];
let worker;
addEventListener('message',event=>{
  if(event.source!==parent||event.data.nonce!==nonce)return;
  if(event.data.kind==='cancel'){worker?.terminate();return;}
  if(event.data.kind!=='run'||worker)return;
  worker=new Worker('worker.js',{type:'module'});
  worker.onmessage=event=>parent.postMessage({kind:'result',nonce,payload:event.data},'*');
  worker.onerror=event=>parent.postMessage({kind:'result',nonce,payload:{error:event.message||'Plugin worker failed'}},'*');
  worker.postMessage(event.data.context);
});
parent.postMessage({kind:'ready',nonce},'*');
"#;
const SCRIPT_WORKER: &str = r#"
import run from './source.js';
self.onmessage=async event=>{
  const logs=[];
  const log=(message,level='info')=>{if(logs.length<200)logs.push({message:String(message).slice(0,2000),level:['warning','error'].includes(level)?level:'info'})};
  console.log=(...args)=>log(args.join(' '));console.warn=(...args)=>log(args.join(' '),'warning');console.error=(...args)=>log(args.join(' '),'error');
  try{const result=await run({...event.data,log});postMessage({result,logs})}
  catch(error){postMessage({error:String(error?.message??error),logs})}
};
"#;

#[tauri::command]
pub async fn plugins_start_script(
    plugin_id: String,
    project_path: Option<String>,
) -> Result<Value, String> {
    let loaded = plugins_load(plugin_id, project_path).await?;
    if loaded["source"].as_str().is_none() {
        return Err("This is not a JavaScript plugin".into());
    }
    let folder = PathBuf::from(
        loaded["path"]
            .as_str()
            .ok_or("Plugin path is unavailable")?,
    );
    let (manifest, fingerprint, files) = inspect(&folder)?;
    if loaded["fingerprint"].as_str() != Some(fingerprint.as_str()) {
        return Err("Plugin changed before execution; enable it again".into());
    }
    let mut modules = HashMap::new();
    let mut hasher = Sha256::new();
    for relative in files {
        let bytes = fs::read(folder.join(&relative)).map_err(|e| e.to_string())?;
        hash_file(&mut hasher, &relative, &bytes);
        if relative
            .extension()
            .and_then(|v| v.to_str())
            .is_some_and(|v| v.eq_ignore_ascii_case("js") || v.eq_ignore_ascii_case("mjs"))
        {
            if bytes.len() > MAX_TEXT_BYTES {
                return Err("A plugin module exceeds 2 MB".into());
            }
            modules.insert(
                format!("plugin/{}", relative.to_string_lossy().replace('\\', "/")),
                String::from_utf8(bytes).map_err(|e| e.to_string())?,
            );
        }
    }
    if format!("{:x}", hasher.finalize()) != fingerprint {
        return Err("Plugin changed while loading; enable it again".into());
    }
    let entry_url = format!(
        "./plugin/{}",
        manifest["entry"].as_str().unwrap().replace('\\', "/")
    );
    let worker = SCRIPT_WORKER.replace(
        "'./source.js'",
        &serde_json::to_string(&entry_url).map_err(|e| e.to_string())?,
    );
    let server = Server::http("127.0.0.1:0").map_err(|e| e.to_string())?;
    let address = server.server_addr().to_string();
    let run_id = uuid::Uuid::new_v4().simple().to_string();
    let active = Arc::new(AtomicBool::new(true));
    SCRIPT_SERVERS
        .lock()
        .map_err(|e| e.to_string())?
        .insert(run_id.clone(), active.clone());
    let thread_id = run_id.clone();
    let expected_host = address.clone();
    std::thread::spawn(move || {
        let started = Instant::now();
        while active.load(Ordering::SeqCst) && started.elapsed() < Duration::from_secs(15) {
            let Ok(Some(request)) = server.recv_timeout(Duration::from_millis(100)) else {
                continue;
            };
            let prefix = format!("/{thread_id}/");
            if request.method() != &tiny_http::Method::Get
                || !request.headers().iter().any(|header| {
                    header.field.equiv("Host") && header.value.as_str() == expected_host
                })
            {
                let _ = request.respond(Response::empty(403));
                continue;
            }
            let route = request.url().strip_prefix(&prefix).and_then(decode_route);
            let (body, mime) = match route.as_deref() {
                Some("index.html") => (
                    "<!doctype html><meta charset=utf-8><script src=bootstrap.js></script>"
                        .to_string(),
                    "text/html; charset=utf-8",
                ),
                Some("bootstrap.js") => (
                    SCRIPT_BOOTSTRAP.to_string(),
                    "text/javascript; charset=utf-8",
                ),
                Some("worker.js") => (worker.clone(), "text/javascript; charset=utf-8"),
                Some(path) if modules.contains_key(path) => {
                    (modules[path].clone(), "text/javascript; charset=utf-8")
                }
                _ => {
                    let _ = request.respond(Response::empty(404));
                    continue;
                }
            };
            let mut response = Response::from_string(body);
            for (name, value) in [
                ("Content-Type", mime), ("Cache-Control", "no-store"), ("X-Content-Type-Options", "nosniff"),
                ("Cross-Origin-Resource-Policy", "same-origin"),
                ("Content-Security-Policy", "default-src 'none'; script-src 'self'; worker-src 'self'; connect-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'")
            ] { if let Ok(header) = Header::from_bytes(name, value) { response.add_header(header); } }
            let _ = request.respond(response);
        }
        if let Ok(mut servers) = SCRIPT_SERVERS.lock() {
            servers.remove(&thread_id);
        }
    });
    Ok(json!({"url": format!("http://{address}/{run_id}/index.html"), "runId": run_id}))
}

fn decode_route(route: &str) -> Option<String> {
    let mut bytes = Vec::new();
    let mut index = 0;
    while index < route.len() {
        if route.as_bytes()[index] == b'%' {
            bytes.push(u8::from_str_radix(route.get(index + 1..index + 3)?, 16).ok()?);
            index += 3;
        } else {
            bytes.push(route.as_bytes()[index]);
            index += 1;
        }
    }
    String::from_utf8(bytes).ok()
}

#[tauri::command]
pub fn plugins_stop_script(run_id: String) -> Result<(), String> {
    if let Some(active) = SCRIPT_SERVERS
        .lock()
        .map_err(|e| e.to_string())?
        .remove(&run_id)
    {
        active.store(false, Ordering::SeqCst);
    }
    Ok(())
}
const PERMISSIONS: &[&str] = &[
    "timeline.read",
    "timeline.write",
    "media.read",
    "project.read",
    "ui.panel",
    "ui.command",
    "color.write",
];

fn id_valid(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 80
        && id.as_bytes()[0].is_ascii_alphanumeric()
        && id
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b"._-".contains(&b))
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}
fn read_json(path: &Path) -> Result<Value, String> {
    let bytes = fs::read(path).map_err(|e| format!("Cannot read {}: {e}", path.display()))?;
    if bytes.len() > MAX_TEXT_BYTES {
        return Err("Plugin JSON exceeds 2 MB".into());
    }
    serde_json::from_slice(&bytes).map_err(|e| format!("Invalid JSON in {}: {e}", path.display()))
}
fn write_json(path: &Path, value: &Value) -> Result<(), String> {
    let temp = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    fs::write(
        &temp,
        serde_json::to_vec_pretty(value).map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    // Windows rename does not replace an existing file. Keep a recovery copy until replacement succeeds.
    let backup = path.with_extension(format!("{}.backup", uuid::Uuid::new_v4()));
    let existed = path.is_file();
    if existed {
        fs::rename(path, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&temp, path) {
        if existed {
            let _ = fs::rename(&backup, path);
        }
        let _ = fs::remove_file(&temp);
        return Err(error.to_string());
    }
    if existed {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}
fn validate_manifest(manifest: &Value) -> Result<(), String> {
    if manifest
        .get("description")
        .is_some_and(|v| v.as_str().is_none_or(|v| v.len() > 2000))
    {
        return Err("Plugin description must be text of at most 2,000 bytes".into());
    }
    let id = manifest["id"].as_str().unwrap_or_default();
    if !id_valid(id) {
        return Err("Plugin id must use lowercase letters, digits, dots, underscores or hyphens (80 characters maximum)".into());
    }
    for key in ["name", "version", "entry"] {
        if manifest[key]
            .as_str()
            .is_none_or(|v| v.trim().is_empty() || v.len() > 200)
        {
            return Err(format!("Plugin {key} is required (200 characters maximum)"));
        }
    }
    let kind = manifest["type"].as_str().unwrap_or_default();
    if !["typescript", "cpp"].contains(&kind) {
        return Err("Plugin type must be typescript or cpp".into());
    }
    let entry = Path::new(manifest["entry"].as_str().unwrap());
    if entry
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Plugin entry must stay inside its package".into());
    }
    let extension = entry
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    if (kind == "cpp" && extension != "dll")
        || (kind == "typescript" && !["js", "mjs"].contains(&extension.as_str()))
    {
        return Err("Use a compiled .js/.mjs entry for TypeScript or a .dll for C++".into());
    }
    let permissions = manifest["permissions"]
        .as_array()
        .ok_or("Plugin permissions must be an array")?;
    if permissions
        .iter()
        .any(|p| !p.as_str().is_some_and(|p| PERMISSIONS.contains(&p)))
    {
        return Err(format!(
            "Supported plugin permissions: {}",
            PERMISSIONS.join(", ")
        ));
    }
    if let Some(parameters) = manifest.get("parameters") {
        let fields = parameters.as_array().ok_or("parameters must be an array")?;
        if fields.len() > 20 {
            return Err("A plugin may define at most 20 parameters".into());
        }
        let mut ids = std::collections::HashSet::new();
        for field in fields {
            let id = field["id"].as_str().unwrap_or_default();
            if !id_valid(id)
                || !ids.insert(id)
                || !["string", "number", "boolean"]
                    .contains(&field["type"].as_str().unwrap_or_default())
                || field["label"]
                    .as_str()
                    .is_none_or(|v| v.is_empty() || v.len() > 100)
            {
                return Err(
                    "Parameters need unique ids, labels, and string/number/boolean types".into(),
                );
            }
            if let Some(options) = field.get("options") {
                if field["type"] != "string"
                    || options.as_array().is_none_or(|v| {
                        v.is_empty()
                            || v.len() > 100
                            || v.iter().any(|s| s.as_str().is_none_or(|s| s.len() > 200))
                    })
                {
                    return Err("Parameter options must be 1–100 short strings".into());
                }
            }
            if field.get("required").is_some_and(|v| !v.is_boolean()) {
                return Err("Parameter required must be a boolean".into());
            }
            for key in ["min", "max", "step"] {
                if field.get(key).is_some_and(|v| {
                    field["type"] != "number" || v.as_f64().is_none_or(|v| !v.is_finite())
                }) {
                    return Err(format!(
                        "Parameter {key} must be a finite number on a numeric parameter"
                    ));
                }
            }
            if field["min"]
                .as_f64()
                .zip(field["max"].as_f64())
                .is_some_and(|(min, max)| min > max)
                || field["step"].as_f64().is_some_and(|v| v <= 0.0)
            {
                return Err("Parameter ranges must be ordered and steps positive".into());
            }
            if let Some(default) = field.get("default") {
                let valid = match field["type"].as_str().unwrap_or_default() {
                    "boolean" => default.is_boolean(),
                    "number" => default.as_f64().is_some_and(|v| {
                        v.is_finite()
                            && v >= field["min"].as_f64().unwrap_or(f64::NEG_INFINITY)
                            && v <= field["max"].as_f64().unwrap_or(f64::INFINITY)
                    }),
                    "string" => default.as_str().is_some_and(|v| {
                        v.len() <= 4000
                            && field["options"]
                                .as_array()
                                .is_none_or(|options| options.contains(default))
                    }),
                    _ => false,
                };
                if !valid {
                    return Err(
                        "Parameter default must match its type and allowed range/options".into(),
                    );
                }
            }
        }
    }
    Ok(())
}
fn walk_files(
    root: &Path,
    current: &Path,
    files: &mut Vec<PathBuf>,
    total: &mut u64,
) -> Result<(), String> {
    if current
        .strip_prefix(root)
        .map_err(|e| e.to_string())?
        .components()
        .count()
        > 16
    {
        return Err("Plugin folders may be at most 16 levels deep".into());
    }
    for entry in fs::read_dir(current).map_err(|e| e.to_string())? {
        let path = entry.map_err(|e| e.to_string())?.path();
        let metadata = fs::symlink_metadata(&path).map_err(|e| e.to_string())?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::MetadataExt;
            if metadata.file_attributes() & 0x400 != 0 {
                return Err("Plugin packages cannot contain links or junctions".into());
            }
        }
        if metadata.file_type().is_symlink() {
            return Err("Plugin packages cannot contain symbolic links".into());
        }
        if metadata.is_dir() {
            walk_files(root, &path, files, total)?;
        } else if metadata.is_file() && path.file_name().is_none_or(|name| name != STATE_FILE) {
            *total += metadata.len();
            if *total > MAX_PACKAGE_BYTES || files.len() >= 1000 {
                return Err("Plugin package exceeds 64 MB or 1,000 files".into());
            }
            files.push(
                path.strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_path_buf(),
            );
        }
    }
    Ok(())
}
fn hash_file(hasher: &mut Sha256, relative: &Path, bytes: &[u8]) {
    let name = relative.to_string_lossy();
    hasher.update((name.len() as u64).to_le_bytes());
    hasher.update(name.as_bytes());
    hasher.update((bytes.len() as u64).to_le_bytes());
    hasher.update(bytes);
}
fn inspect(folder: &Path) -> Result<(Value, String, Vec<PathBuf>), String> {
    let manifest = read_json(&folder.join("plugin.json"))?;
    validate_manifest(&manifest)?;
    let mut files = Vec::new();
    walk_files(folder, folder, &mut files, &mut 0)?;
    files.sort();
    if !files.contains(&PathBuf::from(manifest["entry"].as_str().unwrap())) {
        return Err("Plugin entry file was not found".into());
    }
    let mut hasher = Sha256::new();
    for relative in &files {
        hash_file(
            &mut hasher,
            relative,
            &fs::read(folder.join(relative)).map_err(|e| e.to_string())?,
        );
    }
    Ok((manifest, format!("{:x}", hasher.finalize()), files))
}
fn store_root(project_path: Option<&str>) -> Result<PathBuf, String> {
    let root = if let Some(project) = project_path {
        let project = fs::canonicalize(project).map_err(|e| e.to_string())?;
        if !project.join("project.aivproj").is_file() {
            return Err("Open a valid project before installing project plugins".into());
        }
        let root = project.join("plugins");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        if !root.starts_with(&project) {
            return Err("Project plugins folder points outside the project".into());
        }
        root
    } else {
        let root =
            PathBuf::from(env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is unavailable")?)
                .join("AI Video Editor/plugins");
        fs::create_dir_all(&root).map_err(|e| e.to_string())?;
        fs::canonicalize(root).map_err(|e| e.to_string())?
    };
    Ok(root)
}
fn plugin_path(root: &Path, id: &str) -> Result<PathBuf, String> {
    if !id_valid(id) {
        return Err("Invalid plugin id".into());
    }
    let path = fs::canonicalize(root.join(id)).map_err(|e| e.to_string())?;
    if path.parent() != Some(root) {
        return Err("Plugin folder points outside its store".into());
    }
    Ok(path)
}
fn record(folder: &Path) -> Result<Value, String> {
    let (manifest, fingerprint, _) = inspect(folder)?;
    let state = read_json(&folder.join(STATE_FILE)).unwrap_or_else(|_| json!({}));
    let changed = state["fingerprint"].as_str() != Some(fingerprint.as_str());
    Ok(
        json!({"manifest": manifest, "path": folder, "fingerprint": fingerprint, "enabled": state["enabled"] == true && !changed, "lastRunAt": state["lastRunAt"], "lastError": if changed { json!("Package changed; inspect and enable it again") } else { state["lastError"].clone() }}),
    )
}
fn install_into(root: &Path, source: &Path, replace: bool) -> Result<Value, String> {
    let source = fs::canonicalize(source).map_err(|e| e.to_string())?;
    let (manifest, fingerprint, files) = inspect(&source)?;
    let id = manifest["id"].as_str().unwrap();
    let destination = root.join(id);
    if destination.exists() && !replace {
        return Err("This plugin is already installed; choose Update to replace it".into());
    }
    if destination.exists() {
        plugin_path(root, id)?;
    }
    let staging = root.join(format!(".install-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&staging).map_err(|e| e.to_string())?;
    let copy = (|| {
        for relative in files {
            let destination = staging.join(&relative);
            fs::create_dir_all(destination.parent().unwrap()).map_err(|e| e.to_string())?;
            fs::copy(source.join(relative), destination).map_err(|e| e.to_string())?;
        }
        if inspect(&staging)?.1 != fingerprint {
            return Err("Plugin changed during installation; try again".into());
        }
        write_json(
            &staging.join(STATE_FILE),
            &json!({"enabled": false, "fingerprint": fingerprint}),
        )
    })();
    if let Err(error) = copy {
        let _ = fs::remove_dir_all(&staging);
        return Err(error);
    }
    let backup = root.join(format!(".previous-{}", uuid::Uuid::new_v4()));
    let existed = destination.exists();
    if existed {
        fs::rename(&destination, &backup).map_err(|e| e.to_string())?;
    }
    if let Err(error) = fs::rename(&staging, &destination) {
        if existed {
            let _ = fs::rename(&backup, &destination);
        }
        return Err(error.to_string());
    }
    if existed {
        let _ = fs::remove_dir_all(backup);
    }
    record(&destination)
}

#[tauri::command]
pub async fn plugins_inspect(folder: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (manifest, fingerprint, files) = inspect(Path::new(&folder))?;
        Ok(json!({"manifest": manifest, "fingerprint": fingerprint, "fileCount": files.len()}))
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_install(
    folder: String,
    project_path: Option<String>,
    replace: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        install_into(
            &store_root(project_path.as_deref())?,
            Path::new(&folder),
            replace,
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_list(project_path: Option<String>) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = store_root(project_path.as_deref())?;
        let mut plugins = Vec::new();
        for entry in fs::read_dir(&root).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().to_string();
            if !id_valid(&name) || !entry.path().is_dir() { continue; }
            let result = plugin_path(&root, &name).and_then(|path| record(&path));
            plugins.push(result.unwrap_or_else(|error| json!({"manifest": {"id": name, "name": name, "version": "?", "type": "typescript", "permissions": []}, "enabled": false, "path": entry.path(), "lastError": error, "invalid": true})));
        }
        plugins.sort_by(|a,b| a["manifest"]["name"].as_str().cmp(&b["manifest"]["name"].as_str()));
        let settings = read_json(&root.join(".settings.json")).unwrap_or_else(|_| json!({}));
        Ok(json!({"plugins": plugins, "developerMode": settings["developerMode"] == true}))
    }).await.map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_set_enabled(
    plugin_id: String,
    project_path: Option<String>,
    enabled: bool,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = store_root(project_path.as_deref())?;
        let folder = plugin_path(&root, &plugin_id)?;
        let (manifest, fingerprint, _) = inspect(&folder)?;
        if enabled
            && manifest["type"] == "cpp"
            && read_json(&root.join(".settings.json")).unwrap_or(Value::Null)["developerMode"]
                != true
        {
            return Err("Enable native developer mode before enabling a C++ plugin".into());
        }
        let mut state = read_json(&folder.join(STATE_FILE)).unwrap_or_else(|_| json!({}));
        state["enabled"] = json!(enabled);
        state["fingerprint"] = json!(fingerprint);
        state["lastError"] = Value::Null;
        write_json(&folder.join(STATE_FILE), &state)?;
        record(&folder)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_set_developer_mode(
    project_path: Option<String>,
    enabled: bool,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        write_json(
            &store_root(project_path.as_deref())?.join(".settings.json"),
            &json!({"developerMode": enabled}),
        )
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_remove(plugin_id: String, project_path: Option<String>) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = store_root(project_path.as_deref())?;
        let folder = plugin_path(&root, &plugin_id)?;
        fs::remove_dir_all(folder).map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_load(
    plugin_id: String,
    project_path: Option<String>,
) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = store_root(project_path.as_deref())?;
        let folder = plugin_path(&root, &plugin_id)?;
        let mut result = record(&folder)?;
        if result["enabled"] != true {
            return Err("Enable this plugin before running it".into());
        }
        if result["manifest"]["type"] == "cpp" {
            if read_json(&root.join(".settings.json")).unwrap_or(Value::Null)["developerMode"]
                != true
            {
                return Err("Native developer mode is disabled".into());
            }
        } else {
            let source =
                fs::read_to_string(folder.join(result["manifest"]["entry"].as_str().unwrap()))
                    .map_err(|e| e.to_string())?;
            if source.len() > MAX_TEXT_BYTES {
                return Err("JavaScript entry exceeds 2 MB; bundle a smaller entry".into());
            }
            result["source"] = json!(source);
        }
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}
#[tauri::command]
pub async fn plugins_record_result(
    plugin_id: String,
    project_path: Option<String>,
    error: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _guard = STORE_LOCK.lock().map_err(|e| e.to_string())?;
        let root = store_root(project_path.as_deref())?;
        let folder = plugin_path(&root, &plugin_id)?;
        let mut state = read_json(&folder.join(STATE_FILE))?;
        state["lastRunAt"] = json!(now_ms());
        state["lastError"] = json!(error);
        if error.is_some() {
            state["enabled"] = json!(false);
        }
        write_json(&folder.join(STATE_FILE), &state)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn plugins_run_native(
    plugin_id: String,
    project_path: Option<String>,
    context: Value,
) -> Result<Value, String> {
    let loaded = plugins_load(plugin_id, project_path).await?;
    if loaded["manifest"]["type"] != "cpp" {
        return Err("This plugin is not native".into());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let engine = crate::engine_sidecar::find_engine_executable().ok_or("Engine executable is unavailable")?;
        let folder = PathBuf::from(loaded["path"].as_str().ok_or("Plugin path is unavailable")?);
        let request = serde_json::to_vec(&json!({"entry": folder.join(loaded["manifest"]["entry"].as_str().unwrap()), "context": context})).map_err(|e| e.to_string())?;
        if request.len() > MAX_TEXT_BYTES { return Err("Plugin input exceeds 2 MB".into()); }
        let mut command = Command::new(engine);
        #[cfg(windows)] { use std::os::windows::process::CommandExt; command.creation_flags(0x08000000); }
        let mut child = command.arg("--run-plugin").current_dir(&folder).stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("Cannot open plugin input")?;
        std::thread::spawn(move || { let _ = stdin.write_all(&request).and_then(|_| stdin.write_all(b"\n")); });
        let stdout = child.stdout.take().ok_or("Cannot open plugin output")?;
        let (sender, receiver) = std::sync::mpsc::channel();
        std::thread::spawn(move || { let mut bytes = Vec::new(); let result = stdout.take((MAX_TEXT_BYTES + 1) as u64).read_to_end(&mut bytes).map(|_| bytes); let _ = sender.send(result); });
        let started = Instant::now();
        loop {
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if !status.success() { return Err(format!("Native plugin exited with {status}; the editor session was preserved")); }
                let remaining = Duration::from_secs(5).saturating_sub(started.elapsed());
                let bytes = receiver.recv_timeout(remaining).map_err(|_| "Native plugin output did not close within the time limit")?.map_err(|e| e.to_string())?;
                if bytes.len() > MAX_TEXT_BYTES { return Err("Plugin output exceeds 2 MB".into()); }
                return serde_json::from_slice(&bytes).map_err(|e| format!("Invalid native plugin result: {e}"));
            }
            if started.elapsed() > Duration::from_secs(5) {
                let _ = child.kill(); let _ = child.wait();
                return Err("Native plugin exceeded the 5 second time limit".into());
            }
            std::thread::sleep(Duration::from_millis(20));
        }
    }).await.map_err(|e| e.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn plugin_packages_require_enabling_and_code_changes_invalidate_it() {
        let fixtures =
            env::temp_dir().join(format!("editor-plugin-tests-{}", uuid::Uuid::new_v4()));
        let source = fixtures.join("source");
        let project = fixtures.join("project");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("project.aivproj"), "{}").unwrap();
        let project_arg = || Some(project.to_string_lossy().to_string());
        let manifest = json!({"id":"test.plugin","name":"Test plugin","version":"1.0","type":"typescript","entry":"main.js","permissions":["timeline.read","timeline.write"]});
        write_json(&source.join("plugin.json"), &manifest).unwrap();
        fs::write(
            source.join("main.js"),
            "export default () => ({summary:'ok'})",
        )
        .unwrap();
        let root = store_root(project.to_str()).unwrap();
        let installed = install_into(&root, &source, false).unwrap();
        assert_eq!(installed["enabled"], false);
        assert!(install_into(&root, &source, false).is_err());
        assert!(
            tauri::async_runtime::block_on(plugins_load("test.plugin".into(), project_arg()))
                .is_err()
        );
        let enabled = tauri::async_runtime::block_on(plugins_set_enabled(
            "test.plugin".into(),
            project_arg(),
            true,
        ))
        .unwrap();
        assert_eq!(enabled["enabled"], true);
        let folder = plugin_path(&root, "test.plugin").unwrap();
        fs::write(
            folder.join("main.js"),
            "export default () => ({summary:'changed'})",
        )
        .unwrap();
        assert_eq!(record(&folder).unwrap()["enabled"], false);
        assert!(
            tauri::async_runtime::block_on(plugins_load("test.plugin".into(), project_arg()))
                .is_err()
        );
        tauri::async_runtime::block_on(plugins_set_enabled(
            "test.plugin".into(),
            project_arg(),
            true,
        ))
        .unwrap();
        tauri::async_runtime::block_on(plugins_record_result(
            "test.plugin".into(),
            project_arg(),
            Some("Run failed".into()),
        ))
        .unwrap();
        assert_eq!(record(&folder).unwrap()["enabled"], false);
        assert_eq!(record(&folder).unwrap()["lastError"], "Run failed");
        let mut bad_manifest = manifest.clone();
        bad_manifest["entry"] = json!("../outside.js");
        write_json(&source.join("plugin.json"), &bad_manifest).unwrap();
        assert!(install_into(&root, &source, true).is_err());
        assert_eq!(record(&folder).unwrap()["manifest"], manifest);
        assert!(plugin_path(&root, "../source").is_err());
        assert!(
            tauri::async_runtime::block_on(plugins_remove("..".into(), project_arg())).is_err()
        );
        tauri::async_runtime::block_on(plugins_remove("test.plugin".into(), project_arg()))
            .unwrap();
        assert!(!folder.exists());
        fs::remove_dir_all(fixtures).unwrap();
    }

    #[test]
    fn native_plugins_require_explicit_developer_mode() {
        let project = env::temp_dir().join(format!(
            "editor-native-plugin-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&project).unwrap();
        fs::write(project.join("project.aivproj"), "{}").unwrap();
        let root = store_root(project.to_str()).unwrap();
        let folder = root.join("test.native");
        fs::create_dir(&folder).unwrap();
        write_json(&folder.join("plugin.json"), &json!({"id":"test.native","name":"Native","version":"1","type":"cpp","entry":"main.dll","permissions":[]})).unwrap();
        fs::write(folder.join("main.dll"), "fixture").unwrap();
        let arg = || Some(project.to_string_lossy().to_string());
        assert!(tauri::async_runtime::block_on(plugins_set_enabled(
            "test.native".into(),
            arg(),
            true
        ))
        .is_err());
        tauri::async_runtime::block_on(plugins_set_developer_mode(arg(), true)).unwrap();
        assert_eq!(
            tauri::async_runtime::block_on(plugins_set_enabled("test.native".into(), arg(), true))
                .unwrap()["enabled"],
            true
        );
        tauri::async_runtime::block_on(plugins_set_developer_mode(arg(), false)).unwrap();
        assert!(tauri::async_runtime::block_on(plugins_load("test.native".into(), arg())).is_err());
        fs::remove_dir_all(project).unwrap();
    }
}
