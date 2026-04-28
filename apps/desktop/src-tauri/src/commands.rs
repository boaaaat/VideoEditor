use crate::engine_rpc::send_engine_request;
use crate::preview_url::default_preview_url;
use crate::AppState;
use base64::{engine::general_purpose, Engine as _};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::env;
use std::fs;
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
pub fn preview_resize(state: State<'_, AppState>, rect: PreviewSurfaceRect) -> Result<Value, String> {
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
        duration_us = parse_duration_us(root.get("format").and_then(|format| format.get("duration")));
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
