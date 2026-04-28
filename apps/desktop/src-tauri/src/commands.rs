use crate::engine_rpc::send_engine_request;
use crate::preview_url::default_preview_url;
use crate::AppState;
use base64::{engine::general_purpose, Engine as _};
use serde_json::Value;
use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
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

fn run_ffmpeg_thumbnail(
    ffmpeg: &Path,
    media_path: &str,
    timestamp: &str,
) -> Result<Vec<u8>, String> {
    let output = Command::new(ffmpeg)
        .args([
            "-hide_banner",
            "-loglevel",
            "error",
            "-ss",
            timestamp,
            "-i",
            media_path,
            "-frames:v",
            "1",
            "-vf",
            "scale=160:-1",
            "-f",
            "image2pipe",
            "-vcodec",
            "png",
            "pipe:1",
        ])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .output()
        .map_err(|error| format!("failed to run ffmpeg thumbnail command: {error}"))?;

    if output.status.success() && !output.stdout.is_empty() {
        return Ok(output.stdout);
    }

    Err(format!(
        "ffmpeg thumbnail failed: {}",
        String::from_utf8_lossy(&output.stderr).trim()
    ))
}

fn find_ffmpeg_executable() -> Option<PathBuf> {
    if let Ok(path) = env::var("FFMPEG_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .parent()?
        .to_path_buf();
    let local = repo_root.join("tools/ffmpeg/bin/ffmpeg.exe");
    if fs::metadata(&local)
        .map(|metadata| metadata.is_file())
        .unwrap_or(false)
    {
        return Some(local);
    }

    ["ffmpeg.exe", "ffmpeg"]
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
