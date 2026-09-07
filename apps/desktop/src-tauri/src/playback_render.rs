use crate::{
    commands::find_ffmpeg_executable,
    composition::{cache_root, hash_metadata},
    engine_rpc::send_engine_request,
    AppState,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs,
    io::{Read, Seek, SeekFrom},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, LazyLock, Mutex,
    },
    time::{Duration, Instant},
};
use tauri::Manager;

const MAX_BYTES: u64 = 2 * 1024 * 1024 * 1024;
struct Job {
    id: String,
    cancelled: AtomicBool,
    status: Mutex<Value>,
}
static JOBS: LazyLock<Mutex<VecDeque<Arc<Job>>>> = LazyLock::new(|| Mutex::new(VecDeque::new()));
static RENDERING: AtomicBool = AtomicBool::new(false);

#[tauri::command]
pub fn composition_playback_start(
    app: tauri::AppHandle,
    mut params: Value,
) -> Result<Value, String> {
    let object = params
        .as_object_mut()
        .ok_or("Playback parameters must be an object")?;
    object.remove("resourceDirectory");
    let id = uuid::Uuid::new_v4().to_string();
    let initial = json!({"jobId":id,"state":"queued","progress":0});
    let job = Arc::new(Job {
        id,
        cancelled: AtomicBool::new(false),
        status: Mutex::new(initial.clone()),
    });
    {
        let mut jobs = JOBS.lock().map_err(|e| e.to_string())?;
        let active = |item: &&Arc<Job>| {
            item.status
                .lock()
                .map(|s| matches!(s["state"].as_str(), Some("queued" | "rendering")))
                .unwrap_or(true)
        };
        if jobs.iter().filter(active).count() >= 4 {
            return Err("Playback renderer is busy; cancel an existing request first".into());
        }
        if jobs.len() >= 16 {
            if let Some(index) = jobs.iter().position(|item| !active(&item)) {
                jobs.remove(index);
            }
        }
        jobs.push_back(job.clone());
    }
    tauri::async_runtime::spawn_blocking(move || {
        let result = render(&app, &job, params);
        let status = if job.cancelled.load(Ordering::SeqCst) {
            json!({"jobId":job.id,"state":"cancelled","progress":0})
        } else {
            match result {
                Ok(mut value) => {
                    value["jobId"] = json!(job.id);
                    value
                }
                Err(error) => json!({"jobId":job.id,"state":"failed","error":error,"progress":0}),
            }
        };
        if let Ok(mut current) = job.status.lock() {
            if job.cancelled.load(Ordering::SeqCst) {
                *current = json!({"jobId":job.id,"state":"cancelled","progress":0});
            } else {
                *current = status;
            }
        }
    });
    Ok(initial)
}

#[tauri::command]
pub fn composition_playback_status(job_id: String) -> Result<Value, String> {
    let job = find_job(&job_id)?;
    let status = job.status.lock().map_err(|e| e.to_string())?.clone();
    Ok(status)
}

#[tauri::command]
pub fn composition_playback_cancel(job_id: String) -> Result<Value, String> {
    let job = find_job(&job_id)?;
    let mut status = job.status.lock().map_err(|e| e.to_string())?;
    if matches!(status["state"].as_str(), Some("queued" | "rendering")) {
        job.cancelled.store(true, Ordering::SeqCst);
        *status = json!({"jobId":job.id,"state":"cancelled","progress":0});
    }
    Ok(status.clone())
}

pub fn shutdown() {
    if let Ok(jobs) = JOBS.lock() {
        for job in jobs.iter() {
            job.cancelled.store(true, Ordering::SeqCst);
        }
    }
}

fn find_job(id: &str) -> Result<Arc<Job>, String> {
    JOBS.lock()
        .map_err(|e| e.to_string())?
        .iter()
        .find(|item| item.id == id)
        .cloned()
        .ok_or("Playback job is unavailable; render it again".into())
}

// Kill and reap on every error path, including cancellation and I/O failures.
#[derive(Default)]
struct RenderGuard {
    child: Option<Child>,
    directory: Option<PathBuf>,
    slot: bool,
}
impl Drop for RenderGuard {
    fn drop(&mut self) {
        if let Some(child) = &mut self.child {
            let _ = child.kill();
            let _ = child.wait();
        }
        if let Some(directory) = &self.directory {
            let _ = fs::remove_dir_all(directory);
        }
        if self.slot {
            RENDERING.store(false, Ordering::SeqCst);
        }
    }
}

fn signature(params: &Value) -> String {
    let mut hash = Sha256::new();
    hash.update(b"composition-playback-v1");
    hash.update(params.to_string());
    if let Some(engine) = crate::engine_sidecar::find_engine_executable() {
        hash_metadata(&mut hash, &engine);
    }
    if let Some(ffmpeg) = find_ffmpeg_executable() {
        hash_metadata(&mut hash, &ffmpeg);
    }
    if let Some(assets) = params["mediaAssets"].as_array() {
        for asset in assets {
            if let Some(path) = asset["path"].as_str() {
                hash_metadata(&mut hash, Path::new(path));
            }
        }
    }
    format!("{:x}", hash.finalize())
}

fn render(app: &tauri::AppHandle, job: &Job, mut params: Value) -> Result<Value, String> {
    let project = params["projectPath"].as_str().map(PathBuf::from);
    if let Some(assets) = params["mediaAssets"].as_array_mut() {
        for asset in assets {
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
    let mut guard = RenderGuard::default();
    loop {
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("Playback render cancelled".into());
        }
        if RENDERING
            .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
            .is_ok()
        {
            guard.slot = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let root = cache_root()?.join("playback");
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let key = signature(&params);
    let cached = root.join(format!("{key}.mp4"));
    let manifest = root.join(format!("{key}.json"));
    if let Ok(mut result) = read_cache(&cached, &manifest) {
        result["cached"] = json!(true);
        return Ok(result);
    }
    let directory = root.join(format!(".work-{}", uuid::Uuid::new_v4()));
    fs::create_dir(&directory).map_err(|e| e.to_string())?;
    guard.directory = Some(directory.clone());
    let mut plan_params = params.clone();
    plan_params["resourceDirectory"] = json!(directory);
    let plan = send_engine_request(
        app.state::<AppState>(),
        "composition.playback_plan".into(),
        Some(plan_params),
    )?;
    let duration = plan["durationUs"]
        .as_i64()
        .filter(|value| *value > 0)
        .ok_or("Invalid playback duration")?;
    for file in plan["files"]
        .as_array()
        .ok_or("Missing playback resources")?
    {
        let name = file["name"].as_str().ok_or("Invalid playback resource")?;
        if Path::new(name).components().count() != 1
            || !Path::new(name)
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err("Invalid playback resource path".into());
        }
        fs::write(
            directory.join(name),
            file["content"]
                .as_str()
                .ok_or("Invalid playback resource content")?,
        )
        .map_err(|e| e.to_string())?;
    }
    let arguments = plan["arguments"]
        .as_array()
        .ok_or("Missing playback arguments")?
        .iter()
        .map(|value| value.as_str().ok_or("Invalid playback argument"))
        .collect::<Result<Vec<_>, _>>()?;
    let output = directory.join("playback.mp4");
    let diagnostics = directory.join("stderr.log");
    let mut command = Command::new(find_ffmpeg_executable().ok_or("FFmpeg is unavailable")?);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    guard.child = Some(
        command
            .args(arguments)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(fs::File::create(&diagnostics).map_err(|e| e.to_string())?)
            .spawn()
            .map_err(|e| format!("Cannot start playback renderer: {e}"))?,
    );
    let started = Instant::now();
    loop {
        if job.cancelled.load(Ordering::SeqCst) {
            return Err("Playback render cancelled".into());
        }
        if started.elapsed() > Duration::from_secs(3600) {
            return Err("Playback render exceeded one hour; use a smaller preview size".into());
        }
        if fs::metadata(&output).is_ok_and(|m| m.len() > MAX_BYTES) {
            return Err("Playback render exceeds 2 GB; use a smaller preview size".into());
        }
        if fs::metadata(&diagnostics).is_ok_and(|m| m.len() > 8 * 1024 * 1024) {
            return Err(
                "Playback renderer reported excessive errors; check the source media".into(),
            );
        }
        let text = fs::read_to_string(directory.join("progress.txt")).unwrap_or_default();
        let time = text
            .lines()
            .rev()
            .find_map(|line| {
                line.strip_prefix("out_time_us=")
                    .and_then(|s| s.parse::<i64>().ok())
            })
            .unwrap_or(0);
        if let Ok(mut status) = job.status.lock() {
            if !job.cancelled.load(Ordering::SeqCst) {
                *status = json!({"jobId":job.id,"state":"rendering","progress":(time as f64 / duration as f64).clamp(0.0,0.99),"durationUs":duration,"elapsedSeconds":started.elapsed().as_secs_f64()});
            }
        }
        if let Some(status) = guard
            .child
            .as_mut()
            .unwrap()
            .try_wait()
            .map_err(|e| e.to_string())?
        {
            if !status.success() {
                let mut message = String::new();
                let _ = fs::File::open(&diagnostics)
                    .and_then(|file| file.take(8000).read_to_string(&mut message));
                return Err(format!("Playback render failed: {}", message.trim()));
            }
            guard.child = None;
            break;
        }
        std::thread::sleep(Duration::from_millis(100));
    }
    validate_mp4(&output)?;
    if job.cancelled.load(Ordering::SeqCst) {
        return Err("Playback render cancelled".into());
    }
    if signature(&params) != key {
        return Err("Source media changed while rendering; render playback again".into());
    }
    // Incomplete entries are private cache files and may be replaced. Publish the manifest last.
    let _ = fs::remove_file(&manifest);
    if cached.exists() {
        fs::remove_file(&cached).map_err(|e| e.to_string())?;
    }
    fs::rename(&output, &cached).map_err(|e| e.to_string())?;
    let result = json!({"state":"completed","progress":1,"path":cached,"durationUs":duration,"width":plan["width"],"height":plan["height"],"fps":plan["fps"],"audioEnabled":plan["audioEnabled"],"cached":false,"fileSignature":file_signature(&cached),"description":"SDR timeline playback through the export composition and audio filters, encoded as H.264/AAC for review"});
    let temporary = directory.join("manifest.json");
    fs::write(&temporary, result.to_string()).map_err(|e| e.to_string())?;
    fs::rename(&temporary, &manifest).map_err(|e| e.to_string())?;
    prune(&root, &cached);
    Ok(result)
}

fn file_signature(path: &Path) -> String {
    let mut hash = Sha256::new();
    hash_metadata(&mut hash, path);
    format!("{:x}", hash.finalize())
}
fn read_cache(path: &Path, manifest: &Path) -> Result<Value, String> {
    let value: Value = serde_json::from_slice(&fs::read(manifest).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    if value["fileSignature"] != file_signature(path) || value["path"].as_str() != path.to_str() {
        return Err("Stale playback cache".into());
    }
    validate_mp4(path)?;
    Ok(value)
}

// Walk top-level boxes without loading the movie into memory. A truncated moov
// or mdat must never become a reusable preview, even if its ftyp header is intact.
fn validate_mp4(path: &Path) -> Result<(), String> {
    let mut file = fs::File::open(path).map_err(|e| e.to_string())?;
    let length = file.metadata().map_err(|e| e.to_string())?.len();
    if length < 32 || length > MAX_BYTES {
        return Err("Invalid playback file size".into());
    }
    let mut position = 0u64;
    let (mut ftyp, mut moov, mut mdat) = (false, false, false);
    while position < length {
        let mut header = [0u8; 8];
        file.read_exact(&mut header)
            .map_err(|_| "Incomplete playback file")?;
        let mut size = u32::from_be_bytes(header[..4].try_into().unwrap()) as u64;
        let minimum = if size == 1 {
            let mut large = [0u8; 8];
            file.read_exact(&mut large)
                .map_err(|_| "Incomplete playback box")?;
            size = u64::from_be_bytes(large);
            16
        } else {
            8
        };
        if size == 0 {
            size = length - position;
        }
        if size < minimum || size > length - position {
            return Err("Incomplete playback box".into());
        }
        match &header[4..] {
            b"ftyp" => ftyp = true,
            b"moov" => moov = true,
            b"mdat" => mdat = true,
            _ => {}
        }
        position += size;
        file.seek(SeekFrom::Start(position))
            .map_err(|e| e.to_string())?;
    }
    if !(ftyp && moov && mdat) {
        return Err("Playback file is missing its movie data".into());
    }
    Ok(())
}

fn prune(root: &Path, current: &Path) {
    let Ok(entries) = fs::read_dir(root) else {
        return;
    };
    let mut files = entries
        .filter_map(Result::ok)
        .filter_map(|entry| {
            let path = entry.path();
            let name = path.file_stem()?.to_str()?;
            if path.extension()?.to_str()? != "mp4"
                || name.len() != 64
                || !name.bytes().all(|c| c.is_ascii_hexdigit())
            {
                return None;
            }
            let meta = entry.metadata().ok()?;
            Some((path, meta.len(), meta.modified().ok()?))
        })
        .collect::<Vec<_>>();
    files.sort_by_key(|(_, _, time)| std::cmp::Reverse(*time));
    let mut bytes = 0;
    for (index, (path, size, _)) in files.into_iter().enumerate() {
        bytes += size;
        if path != current && (index >= 12 || bytes > MAX_BYTES) && fs::remove_file(&path).is_ok() {
            let _ = fs::remove_file(path.with_extension("json"));
        }
    }
}
