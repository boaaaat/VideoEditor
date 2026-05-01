use crate::engine_rpc::send_engine_request;
use crate::preview_url::default_preview_url;
use crate::AppState;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use tauri::State;

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PreviewSurfaceRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    scale_factor: f64,
}

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

#[tauri::command]
pub fn preview_attach(
    state: State<'_, AppState>,
    window: tauri::Window,
    rect: PreviewSurfaceRect,
) -> Result<Value, String> {
    let parent_hwnd = parent_hwnd(&window)?;
    send_engine_request(
        state,
        "preview.attach".to_string(),
        Some(json!({
            "parentHwnd": parent_hwnd,
            "rect": rect
        })),
    )
}

#[tauri::command]
pub fn preview_resize(
    state: State<'_, AppState>,
    rect: PreviewSurfaceRect,
) -> Result<Value, String> {
    send_engine_request(
        state,
        "preview.resize".to_string(),
        Some(json!({
            "rect": rect
        })),
    )
}

#[tauri::command]
pub fn media_thumbnail_data_url(path: String) -> Result<String, String> {
    let ffmpeg = find_ffmpeg_executable()
        .ok_or_else(|| "could not find ffmpeg in tools/ffmpeg/bin or PATH".to_string())?;

    let bytes = run_ffmpeg_thumbnail(&ffmpeg, &path, "00:00:00.250")
        .or_else(|_| run_ffmpeg_thumbnail(&ffmpeg, &path, "00:00:00.000"))?;

    if bytes.is_empty() {
        return Err("ffmpeg produced an empty thumbnail".to_string());
    }

    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn media_probe(path: String) -> Result<Value, String> {
    let ffprobe = find_ffprobe_executable()
        .ok_or_else(|| "could not find ffprobe in tools/ffmpeg/bin or PATH".to_string())?;

    let output = Command::new(ffprobe)
        .args([
            "-v",
            "error",
            "-print_format",
            "json",
            "-show_format",
            "-show_streams",
            &path,
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("failed to run ffprobe: {error}"))?;

    if !output.status.success() {
        return Err(format!(
            "ffprobe failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    let root: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("invalid ffprobe JSON: {error}"))?;
    Ok(parse_media_metadata(&path, &root))
}

#[tauri::command]
pub fn media_preview_frame_data_url(path: String, time_us: i64) -> Result<String, String> {
    let ffmpeg = find_ffmpeg_executable()
        .ok_or_else(|| "could not find ffmpeg in tools/ffmpeg/bin or PATH".to_string())?;

    let timestamp = format_ffmpeg_timestamp(time_us);
    let bytes = run_ffmpeg_frame(&ffmpeg, &path, &timestamp, "", true)
        .or_else(|_| run_ffmpeg_frame(&ffmpeg, &path, &timestamp, "", false))
        .or_else(|_| run_ffmpeg_frame(&ffmpeg, &path, "0.000", "", true))
        .or_else(|_| run_ffmpeg_frame(&ffmpeg, &path, "0.000", "", false))?;

    if bytes.is_empty() {
        return Err("ffmpeg produced an empty preview frame".to_string());
    }

    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn media_waveform_data_url(
    path: String,
    start_us: Option<i64>,
    duration_us: Option<i64>,
) -> Result<String, String> {
    let ffmpeg = find_ffmpeg_executable()
        .ok_or_else(|| "could not find ffmpeg in tools/ffmpeg/bin or PATH".to_string())?;

    let bytes = run_ffmpeg_waveform(&ffmpeg, &path, start_us, duration_us)?;
    if bytes.is_empty() {
        return Err("ffmpeg produced an empty waveform".to_string());
    }

    Ok(format!(
        "data:image/png;base64,{}",
        general_purpose::STANDARD.encode(bytes)
    ))
}

#[tauri::command]
pub fn media_proxy_status(
    path: String,
    project_path: String,
    needed: bool,
) -> Result<Value, String> {
    let proxy_path = proxy_path_for(&path, &project_path);
    let status = if !needed {
        "not-needed"
    } else if proxy_path.is_file() {
        "ready"
    } else {
        "missing"
    };

    Ok(json!({
        "status": status,
        "path": proxy_path
    }))
}

#[tauri::command]
pub async fn media_generate_proxy(path: String, project_path: String) -> Result<Value, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let media_path = PathBuf::from(normalize_media_path(&path));
        if !media_path.is_file() {
            return Err("media file does not exist".to_string());
        }

        let ffmpeg = find_ffmpeg_executable()
            .ok_or_else(|| "could not find ffmpeg in tools/ffmpeg/bin or PATH".to_string())?;
        let proxy_path = proxy_path_for(&path, &project_path);
        let proxy_dir = proxy_path
            .parent()
            .ok_or_else(|| "proxy path has no parent folder".to_string())?;
        fs::create_dir_all(proxy_dir)
            .map_err(|error| format!("failed to create proxy cache folder: {error}"))?;

        let temp_path = proxy_path.with_extension("proxy.tmp.mp4");
        if temp_path.exists() {
            fs::remove_file(&temp_path)
                .map_err(|error| format!("failed to clear stale proxy temp file: {error}"))?;
        }

        let output = Command::new(ffmpeg)
            .args(["-hide_banner", "-loglevel", "error", "-y", "-i"])
            .arg(&media_path)
            .args([
                "-map",
                "0:v:0",
                "-map",
                "0:a?",
                "-vf",
                "scale=-2:min(720\\,ih),format=yuv420p",
                "-c:v",
                "libx264",
                "-preset",
                "veryfast",
                "-crf",
                "28",
                "-c:a",
                "aac",
                "-b:a",
                "128k",
                "-movflags",
                "+faststart",
            ])
            .arg(&temp_path)
            .stdout(Stdio::null())
            .stderr(Stdio::piped())
            .output()
            .map_err(|error| format!("failed to run ffmpeg proxy command: {error}"))?;

        if !output.status.success() {
            let _ = fs::remove_file(&temp_path);
            return Err(format!(
                "proxy generation failed: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }

        if !temp_path.is_file() {
            return Err("ffmpeg did not create a proxy file".to_string());
        }

        if proxy_path.exists() {
            fs::remove_file(&proxy_path)
                .map_err(|error| format!("failed to replace existing proxy: {error}"))?;
        }
        fs::rename(&temp_path, &proxy_path)
            .map_err(|error| format!("failed to finalize proxy file: {error}"))?;

        Ok(json!({
            "status": "ready",
            "path": proxy_path
        }))
    })
    .await
    .map_err(|error| format!("proxy generation task failed: {error}"))?
}

#[tauri::command]
pub fn reveal_media_path(path: String) -> Result<(), String> {
    let media_path = PathBuf::from(normalize_media_path(&path));
    let target = if media_path.is_file() {
        media_path
    } else {
        media_path
            .parent()
            .map(Path::to_path_buf)
            .filter(|parent| parent.exists())
            .ok_or_else(|| "media path does not exist".to_string())?
    };

    reveal_path(&target)
}

#[tauri::command]
pub fn delete_project_folder(project_path: String) -> Result<(), String> {
    let path = PathBuf::from(project_path);
    if !path.exists() {
        return Ok(());
    }
    if !path.is_dir() {
        return Err("project path is not a folder".to_string());
    }
    if !path.join("project.aivproj").is_file() {
        return Err("refusing to delete a folder without project.aivproj".to_string());
    }

    fs::remove_dir_all(&path).map_err(|error| format!("failed to delete project folder: {error}"))
}

#[tauri::command]
pub fn append_app_log(project_path: String, entry: Value) -> Result<(), String> {
    let timestamp = entry
        .get("timestamp")
        .and_then(Value::as_str)
        .ok_or_else(|| "log entry timestamp missing".to_string())?;
    let date = timestamp
        .get(0..10)
        .filter(|value| is_iso_date(value))
        .ok_or_else(|| "log entry timestamp must start with YYYY-MM-DD".to_string())?;
    let logs_dir = PathBuf::from(project_path).join("logs");
    fs::create_dir_all(&logs_dir)
        .map_err(|error| format!("failed to create project logs folder: {error}"))?;

    let log_path = logs_dir.join(format!("app-{date}.jsonl"));
    let mut file = OpenOptions::new()
        .create(true)
        .append(true)
        .open(&log_path)
        .map_err(|error| format!("failed to open app log file: {error}"))?;
    let line = serde_json::to_string(&entry)
        .map_err(|error| format!("failed to serialize app log entry: {error}"))?;
    writeln!(file, "{line}").map_err(|error| format!("failed to write app log entry: {error}"))
}

#[tauri::command]
pub fn save_project_snapshot(project_path: String, snapshot: Value) -> Result<(), String> {
    let cache_dir = PathBuf::from(project_path).join("cache");
    fs::create_dir_all(&cache_dir)
        .map_err(|error| format!("failed to create project cache folder: {error}"))?;
    let snapshot_path = cache_dir.join("ui-state.json");
    let content = serde_json::to_string_pretty(&snapshot)
        .map_err(|error| format!("failed to serialize project snapshot: {error}"))?;
    fs::write(&snapshot_path, format!("{content}\n"))
        .map_err(|error| format!("failed to write project snapshot: {error}"))
}

#[tauri::command]
pub fn load_project_snapshot(project_path: String) -> Result<Option<Value>, String> {
    let snapshot_path = PathBuf::from(project_path)
        .join("cache")
        .join("ui-state.json");
    if !snapshot_path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(&snapshot_path)
        .map_err(|error| format!("failed to read project snapshot: {error}"))?;
    let snapshot = serde_json::from_str(&content)
        .map_err(|error| format!("invalid project snapshot JSON: {error}"))?;
    Ok(Some(snapshot))
}

#[tauri::command]
pub fn validate_media_paths(paths: Vec<String>, project_path: Option<String>) -> Vec<String> {
    paths
        .into_iter()
        .filter(|path| !resolve_media_path(path, project_path.as_deref()).exists())
        .collect()
}

fn resolve_media_path(path: &str, project_path: Option<&str>) -> PathBuf {
    let normalized = normalize_media_path(path);
    let media_path = PathBuf::from(&normalized);
    if media_path.is_absolute() || project_path.is_none() {
        return media_path;
    }

    PathBuf::from(project_path.unwrap()).join(media_path)
}

fn normalize_media_path(path: &str) -> String {
    let trimmed = path.trim();
    let without_scheme = if let Some(rest) = trimmed.strip_prefix("file://") {
        rest
    } else if let Some(rest) = trimmed.strip_prefix("asset://localhost/") {
        rest
    } else {
        trimmed
    };

    let decoded = percent_decode_path(without_scheme);
    if decoded.len() > 2 && decoded.as_bytes()[0] == b'/' && decoded.as_bytes()[2] == b':' {
        return decoded[1..].to_string();
    }
    decoded
}

fn proxy_path_for(path: &str, project_path: &str) -> PathBuf {
    let media_path = PathBuf::from(normalize_media_path(path));
    let proxy_file_name = media_path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("media");
    PathBuf::from(project_path)
        .join("cache")
        .join("proxies")
        .join(proxy_file_name)
        .with_extension("proxy.mp4")
}

fn percent_decode_path(path: &str) -> String {
    let bytes = path.as_bytes();
    let mut output = Vec::with_capacity(path.len());
    let mut index = 0;
    while index < bytes.len() {
        if bytes[index] == b'%' && index + 2 < bytes.len() {
            if let (Some(high), Some(low)) =
                (hex_value(bytes[index + 1]), hex_value(bytes[index + 2]))
            {
                output.push(high * 16 + low);
                index += 3;
                continue;
            }
        }
        output.push(bytes[index]);
        index += 1;
    }
    String::from_utf8_lossy(&output).to_string()
}

fn hex_value(value: u8) -> Option<u8> {
    match value {
        b'0'..=b'9' => Some(value - b'0'),
        b'a'..=b'f' => Some(value - b'a' + 10),
        b'A'..=b'F' => Some(value - b'A' + 10),
        _ => None,
    }
}

fn is_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 10
        && bytes[4] == b'-'
        && bytes[7] == b'-'
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| index == 4 || index == 7 || byte.is_ascii_digit())
}

fn parent_hwnd(window: &tauri::Window) -> Result<String, String> {
    #[cfg(windows)]
    {
        let hwnd = window
            .hwnd()
            .map_err(|error| format!("failed to get native window handle: {error}"))?;
        Ok((hwnd.0 as isize).to_string())
    }

    #[cfg(not(windows))]
    {
        let _ = window;
        Err("native preview embedding is only supported on Windows".to_string())
    }
}

fn reveal_path(path: &Path) -> Result<(), String> {
    #[cfg(windows)]
    {
        let mut command = Command::new("explorer.exe");
        if path.is_file() {
            command.arg("/select,").arg(path);
        } else {
            command.arg(path);
        }
        command
            .spawn()
            .map(|_| ())
            .map_err(|error| format!("failed to reveal media path: {error}"))
    }

    #[cfg(not(windows))]
    {
        let _ = path;
        Err("reveal in file manager is only supported on Windows".to_string())
    }
}

fn run_ffmpeg_thumbnail(
    ffmpeg: &Path,
    media_path: &str,
    timestamp: &str,
) -> Result<Vec<u8>, String> {
    run_ffmpeg_frame(ffmpeg, media_path, timestamp, "scale=160:-1", false)
}

fn run_ffmpeg_frame(
    ffmpeg: &Path,
    media_path: &str,
    timestamp: &str,
    scale_filter: &str,
    use_hwaccel: bool,
) -> Result<Vec<u8>, String> {
    let mut command = Command::new(ffmpeg);
    command.args(["-hide_banner", "-loglevel", "error"]);
    if use_hwaccel {
        command.args(["-hwaccel", "cuda"]);
    }
    command.args(["-ss", timestamp, "-i", media_path, "-frames:v", "1"]);
    if !scale_filter.is_empty() {
        command.args(["-vf", scale_filter]);
    }
    let output = command
        .args(["-f", "image2pipe", "-vcodec", "png", "pipe:1"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("failed to run ffmpeg frame command: {error}"))?;

    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }

    Err(format!(
        "ffmpeg thumbnail failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn run_ffmpeg_waveform(
    ffmpeg: &Path,
    media_path: &str,
    start_us: Option<i64>,
    duration_us: Option<i64>,
) -> Result<Vec<u8>, String> {
    let mut args = vec![
        "-hide_banner".to_string(),
        "-loglevel".to_string(),
        "error".to_string(),
    ];
    if let Some(start_us) = start_us.filter(|value| *value > 0) {
        args.extend(["-ss".to_string(), format_ffmpeg_timestamp(start_us)]);
    }
    args.extend(["-i".to_string(), media_path.to_string()]);
    if let Some(duration_us) = duration_us.filter(|value| *value > 0) {
        args.extend(["-t".to_string(), format_ffmpeg_timestamp(duration_us)]);
    }
    args.extend([
        "-filter_complex".to_string(),
        "aformat=channel_layouts=mono,showwavespic=s=1800x240:colors=7bb65f".to_string(),
        "-frames:v".to_string(),
        "1".to_string(),
        "-f".to_string(),
        "image2pipe".to_string(),
        "-vcodec".to_string(),
        "png".to_string(),
        "pipe:1".to_string(),
    ]);

    let output = Command::new(ffmpeg)
        .args(args)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("failed to run ffmpeg waveform command: {error}"))?;

    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }

    Err(format!(
        "ffmpeg waveform failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn format_ffmpeg_timestamp(time_us: i64) -> String {
    let seconds = (time_us.max(0) as f64) / 1_000_000.0;
    format!("{seconds:.3}")
}

fn parse_media_metadata(path: &str, root: &Value) -> Value {
    let mut width = 0_i64;
    let mut height = 0_i64;
    let mut fps = 0.0_f64;
    let mut duration_us = 0_i64;
    let mut codec = "unknown".to_string();
    let mut pixel_format = "unknown".to_string();
    let mut color_transfer = "unknown".to_string();
    let mut hdr = false;
    let mut has_audio = false;

    if let Some(streams) = root.get("streams").and_then(Value::as_array) {
        for stream in streams {
            let codec_type = stream
                .get("codec_type")
                .and_then(Value::as_str)
                .unwrap_or_default();

            if codec_type == "audio" {
                has_audio = true;
                continue;
            }

            if codec_type != "video" || width > 0 {
                continue;
            }

            width = stream.get("width").and_then(Value::as_i64).unwrap_or(0);
            height = stream.get("height").and_then(Value::as_i64).unwrap_or(0);
            codec = stream
                .get("codec_name")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            pixel_format = stream
                .get("pix_fmt")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            color_transfer = stream
                .get("color_transfer")
                .and_then(Value::as_str)
                .unwrap_or("unknown")
                .to_string();
            fps = parse_frame_rate(
                stream
                    .get("avg_frame_rate")
                    .and_then(Value::as_str)
                    .unwrap_or_default(),
            );
            if fps <= 0.0 {
                fps = parse_frame_rate(
                    stream
                        .get("r_frame_rate")
                        .and_then(Value::as_str)
                        .unwrap_or_default(),
                );
            }
            duration_us = parse_duration_us(stream.get("duration"));
            let color_primaries = stream
                .get("color_primaries")
                .and_then(Value::as_str)
                .unwrap_or_default();
            hdr = color_transfer == "smpte2084"
                || color_transfer == "arib-std-b67"
                || (color_primaries == "bt2020" && pixel_format.contains("10"));
        }
    }

    if duration_us <= 0 {
        duration_us =
            parse_duration_us(root.get("format").and_then(|format| format.get("duration")));
    }

    json!({
        "path": path,
        "width": width,
        "height": height,
        "fps": fps,
        "durationUs": duration_us,
        "codec": codec,
        "pixelFormat": pixel_format,
        "colorTransfer": color_transfer,
        "hdr": hdr,
        "hasAudio": has_audio
    })
}

fn parse_frame_rate(value: &str) -> f64 {
    if value.is_empty() || value == "0/0" {
        return 0.0;
    }

    if let Some((numerator, denominator)) = value.split_once('/') {
        let numerator = numerator.parse::<f64>().unwrap_or(0.0);
        let denominator = denominator.parse::<f64>().unwrap_or(0.0);
        if denominator == 0.0 {
            return 0.0;
        }
        return numerator / denominator;
    }

    value.parse::<f64>().unwrap_or(0.0)
}

fn parse_duration_us(value: Option<&Value>) -> i64 {
    let seconds = match value {
        Some(Value::String(value)) => value.parse::<f64>().unwrap_or(0.0),
        Some(Value::Number(value)) => value.as_f64().unwrap_or(0.0),
        _ => 0.0,
    };

    if seconds > 0.0 {
        (seconds * 1_000_000.0).round() as i64
    } else {
        0
    }
}

fn find_ffmpeg_executable() -> Option<PathBuf> {
    find_ffmpeg_tool_executable("ffmpeg")
}

fn find_ffprobe_executable() -> Option<PathBuf> {
    find_ffmpeg_tool_executable("ffprobe")
}

fn find_ffmpeg_tool_executable(tool_name: &str) -> Option<PathBuf> {
    if let Ok(path) = env::var("FFMPEG_PATH") {
        let candidate = PathBuf::from(path);
        if tool_name == "ffmpeg" && candidate.is_file() {
            return Some(candidate);
        }
    }

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .parent()?
        .to_path_buf();
    let executable = if cfg!(windows) {
        format!("{tool_name}.exe")
    } else {
        tool_name.to_string()
    };
    let local = repo_root.join("tools/ffmpeg/bin").join(&executable);
    if fs::metadata(&local)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Some(local);
    }

    [executable, tool_name.to_string()]
        .into_iter()
        .map(PathBuf::from)
        .find(|candidate| {
            Command::new(candidate)
                .arg("-version")
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status()
                .map(|status| status.success())
                .unwrap_or(false)
        })
}
