use crate::{commands::find_ffmpeg_executable, engine_rpc::send_engine_request, AppState};
use base64::{engine::general_purpose, Engine as _};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::Read,
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicUsize, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const MAX_PNG_BYTES: u64 = 16 * 1024 * 1024;
static REQUESTS: LazyLock<Mutex<HashMap<String, Arc<AtomicBool>>>> =
    LazyLock::new(|| Mutex::new(HashMap::new()));
static RENDERS: AtomicUsize = AtomicUsize::new(0);

#[tauri::command]
pub fn composition_cancel(request_id: String) {
    if let Ok(requests) = REQUESTS.lock() {
        if let Some(cancelled) = requests.get(&request_id) {
            cancelled.store(true, Ordering::SeqCst);
        }
    }
}

struct RenderGuard {
    request_id: String,
    workspace: Option<PathBuf>,
    owns_slot: bool,
}
impl Drop for RenderGuard {
    fn drop(&mut self) {
        if let Ok(mut requests) = REQUESTS.lock() {
            requests.remove(&self.request_id);
        }
        // The workspace is always a unique direct child created under our cache root.
        if let Some(path) = &self.workspace {
            if path
                .file_name()
                .is_some_and(|name| name.to_string_lossy().starts_with(".work-"))
            {
                let _ = fs::remove_dir_all(path);
            }
        }
        if self.owns_slot {
            RENDERS.fetch_sub(1, Ordering::SeqCst);
        }
    }
}

#[tauri::command]
pub async fn composition_frame(
    app: tauri::AppHandle,
    request_id: String,
    mut params: Value,
) -> Result<Value, String> {
    if !params.is_object() {
        return Err("Frame parameters must be an object".into());
    }
    if request_id.len() > 100 || request_id.is_empty() {
        return Err("Invalid frame request id".into());
    }
    let cancelled = Arc::new(AtomicBool::new(false));
    {
        let mut requests = REQUESTS.lock().map_err(|e| e.to_string())?;
        if requests.contains_key(&request_id) {
            return Err("Frame request id is already running".into());
        }
        requests.insert(request_id.clone(), cancelled.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let mut guard = RenderGuard {
            request_id,
            workspace: None,
            owns_slot: false,
        };
        let project = params["projectPath"].as_str().map(PathBuf::from);
        if let Some(media) = params["mediaAssets"].as_array_mut() {
            for asset in media {
                if let Some(path) = asset["path"].as_str() {
                    let path = PathBuf::from(path);
                    if path.is_relative() {
                        if let Some(root) = &project {
                            asset["path"] = json!(root.join(path));
                        }
                    }
                }
            }
        }
        let root = cache_root()?;
        params
            .as_object_mut()
            .ok_or("Frame parameters must be an object")?
            .remove("resourceDirectory");
        let mut hasher = Sha256::new();
        hasher.update(b"composition-frame-v1");
        hasher.update(serde_json::to_vec(&params).map_err(|e| e.to_string())?);
        if let Some(engine) = crate::engine_sidecar::find_engine_executable() {
            hash_metadata(&mut hasher, &engine);
        }
        if let Some(media) = params["mediaAssets"].as_array() {
            for asset in media {
                if let Some(path) = asset["path"].as_str() {
                    hash_metadata(&mut hasher, Path::new(path));
                }
            }
        }
        let key = format!("{:x}", hasher.finalize());
        let cached = root.join(format!("{key}.png"));
        let time_us = params["timeUs"]
            .as_i64()
            .ok_or("Frame time must be integer microseconds")?;
        let fps = params["fps"].as_i64().unwrap_or(30);
        if fps < 1 || fps > 120 || time_us < 0 {
            return Err("Invalid frame time or rate".into());
        }
        let frame_time = (((time_us as f64 + 0.5) * fps as f64 / 1_000_000.0).floor() * 1_000_000.0
            / fps as f64)
            .round() as i64;
        if cached.is_file() {
            if let Ok(result) = frame_result(&cached, frame_time, true) {
                return Ok(result);
            }
            let _ = fs::remove_file(&cached);
        }
        let wait_started = Instant::now();
        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Frame request cancelled".into());
            }
            if RENDERS
                .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |count| {
                    (count < 2).then_some(count + 1)
                })
                .is_ok()
            {
                guard.owns_slot = true;
                break;
            }
            if wait_started.elapsed() > Duration::from_secs(15) {
                return Err("Preview renderer is busy; retry when idle".into());
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let directory = root.join(format!(".work-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).map_err(|e| e.to_string())?;
        guard.workspace = Some(directory.clone());
        params["resourceDirectory"] = json!(directory);
        let plan = send_engine_request(
            app.state::<AppState>(),
            "composition.frame_plan".into(),
            Some(params),
        )?;
        for file in plan["files"]
            .as_array()
            .ok_or("Frame plan has no resources")?
        {
            let name = file["name"].as_str().ok_or("Invalid frame resource name")?;
            if Path::new(name).components().count() != 1
                || !Path::new(name)
                    .components()
                    .all(|part| matches!(part, Component::Normal(_)))
            {
                return Err("Invalid frame resource path".into());
            }
            fs::write(
                directory.join(name),
                file["content"]
                    .as_str()
                    .ok_or("Invalid frame resource content")?,
            )
            .map_err(|e| e.to_string())?;
        }
        let arguments = plan["arguments"]
            .as_array()
            .ok_or("Frame plan has no arguments")?
            .iter()
            .map(|value| {
                value
                    .as_str()
                    .map(str::to_string)
                    .ok_or("Invalid frame argument")
            })
            .collect::<Result<Vec<_>, _>>()?;
        let ffmpeg = find_ffmpeg_executable().ok_or("FFmpeg is unavailable")?;
        let diagnostics = directory.join("stderr.log");
        let mut command = Command::new(ffmpeg);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(&diagnostics).map_err(|e| e.to_string())?)
            .spawn()
            .map_err(|e| format!("Could not start composition renderer: {e}"))?;
        let started = Instant::now();
        loop {
            if cancelled.load(Ordering::SeqCst) || started.elapsed() > Duration::from_secs(15) {
                let _ = child.kill();
                let _ = child.wait();
                return Err(if cancelled.load(Ordering::SeqCst) {
                    "Frame request cancelled"
                } else {
                    "Composition frame exceeded its 15 second time limit"
                }
                .into());
            }
            if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
                if !status.success() {
                    let mut message = String::new();
                    let _ = fs::File::open(&diagnostics)
                        .and_then(|file| file.take(8000).read_to_string(&mut message));
                    return Err(format!("Composition frame failed: {}", message.trim()));
                }
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        let output = directory.join("frame.png");
        let result = frame_result(
            &output,
            plan["timeUs"].as_i64().ok_or("Missing frame time")?,
            false,
        )?;
        // Publish atomically on the same volume so concurrent requests never read half a PNG.
        // On Windows an already populated destination may make rename fail; that is harmless.
        let _ = fs::rename(&output, &cached);
        prune_cache(&root);
        Ok(result)
    })
    .await
    .map_err(|e| e.to_string())?
}

fn cache_root() -> Result<PathBuf, String> {
    let root =
        PathBuf::from(std::env::var("LOCALAPPDATA").map_err(|_| "LOCALAPPDATA is unavailable")?)
            .join("AI Video Editor/cache/composition");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let absolute = fs::canonicalize(root).map_err(|e| e.to_string())?;
    #[cfg(windows)]
    {
        let text = absolute.to_string_lossy();
        if let Some(path) = text.strip_prefix("\\\\?\\UNC\\") {
            return Ok(PathBuf::from(format!("\\\\{path}")));
        }
        if let Some(path) = text.strip_prefix("\\\\?\\") {
            return Ok(PathBuf::from(path));
        }
    }
    Ok(absolute)
}
fn hash_metadata(hasher: &mut Sha256, path: &Path) {
    if let Ok(metadata) = fs::metadata(path) {
        hasher.update(metadata.len().to_le_bytes());
        if let Ok(time) = metadata.modified().and_then(|time| {
            time.duration_since(std::time::UNIX_EPOCH)
                .map_err(std::io::Error::other)
        }) {
            hasher.update(time.as_nanos().to_le_bytes());
        }
    }
}
fn frame_result(path: &Path, time_us: i64, cached: bool) -> Result<Value, String> {
    let metadata = fs::metadata(path).map_err(|_| "The composition renderer produced no frame")?;
    if metadata.len() > MAX_PNG_BYTES {
        return Err("Composition frame exceeds 16 MB; use a smaller preview size".into());
    }
    let bytes = fs::read(path).map_err(|e| e.to_string())?;
    if bytes.len() < 57
        || &bytes[..8] != b"\x89PNG\r\n\x1a\n"
        || &bytes[8..16] != b"\x00\x00\x00\x0dIHDR"
        || !bytes.ends_with(b"\x00\x00\x00\x00IEND\xae\x42\x60\x82")
    {
        return Err("Composition renderer returned an invalid PNG".into());
    }
    let width = u32::from_be_bytes(bytes[16..20].try_into().unwrap());
    let height = u32::from_be_bytes(bytes[20..24].try_into().unwrap());
    if width == 0 || height == 0 {
        return Err("Composition renderer returned an empty PNG".into());
    }
    Ok(
        json!({"dataUrl":format!("data:image/png;base64,{}",general_purpose::STANDARD.encode(bytes)),"timeUs":time_us,"width":width,"height":height,"cached":cached,"description":"Timeline composition including visible video layers, transforms, color, effects, titles and captions; no audio"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn incomplete_cached_png_is_rejected_and_complete_frame_keeps_metadata() {
        let directory =
            std::env::temp_dir().join(format!("composition-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("frame.png");
        let png = general_purpose::STANDARD.decode("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aZ1sAAAAASUVORK5CYII=").unwrap();
        for length in [0, 8, 24, png.len() - 1] {
            fs::write(&path, &png[..length]).unwrap();
            assert!(frame_result(&path, 33_333, true).is_err());
        }
        fs::write(&path, &png).unwrap();
        let result = frame_result(&path, 33_333, true).unwrap();
        assert_eq!(result["width"], 1);
        assert_eq!(result["height"], 1);
        assert_eq!(result["timeUs"], 33_333);
        assert_eq!(result["cached"], true);
        fs::remove_file(path).unwrap();
        fs::remove_dir(directory).unwrap();
    }
}
fn prune_cache(root: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_stem()?.to_str()?;
            if path.extension()?.to_str()? != "png"
                || name.len() != 64
                || !name.bytes().all(|byte| byte.is_ascii_hexdigit())
            {
                return None;
            }
            let metadata = entry.metadata().ok()?;
            Some((path, metadata.len(), metadata.modified().ok()?))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, _, time)| std::cmp::Reverse(*time));
    let mut bytes = 0;
    for (index, (path, size, _)) in files.into_iter().enumerate() {
        bytes += size;
        if index >= 256 || bytes > 128 * 1024 * 1024 {
            let _ = fs::remove_file(path);
        }
    }
}
