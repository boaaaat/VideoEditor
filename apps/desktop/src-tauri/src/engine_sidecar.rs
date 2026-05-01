use serde_json::{json, Value};
use std::env;
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

pub struct EngineSidecar {
    child: Child,
    stdin: ChildStdin,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
}

impl EngineSidecar {
    pub fn start() -> Result<Self, String> {
        let repo_root =
            repo_root().ok_or_else(|| "could not resolve repository root".to_string())?;
        let exe = find_engine_executable().ok_or_else(|| {
            "could not find ai-video-engine.exe; run pnpm engine:build first".to_string()
        })?;
        let ffmpeg_dir = repo_root.join("tools/ffmpeg/bin");

        let mut child = Command::new(&exe)
            .arg("--stdio")
            .current_dir(&repo_root)
            .env("AI_VIDEO_FFMPEG_DIR", &ffmpeg_dir)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|error| {
                format!(
                    "failed to start engine sidecar at {}: {error}",
                    exe.display()
                )
            })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "failed to open engine stdin".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "failed to open engine stdout".to_string())?;

        Ok(Self {
            child,
            stdin,
            stdout: BufReader::new(stdout),
            next_id: 1,
        })
    }

    pub fn request(&mut self, method: &str, params: Value) -> Result<Value, String> {
        if let Some(status) = self.child.try_wait().map_err(|error| error.to_string())? {
            return Err(format!("engine sidecar exited with status {status}"));
        }

        let id = self.next_id;
        self.next_id += 1;

        let request = json!({
            "jsonrpc": "2.0",
            "id": id,
            "method": method,
            "params": params
        });

        writeln!(self.stdin, "{request}").map_err(|error| error.to_string())?;
        self.stdin.flush().map_err(|error| error.to_string())?;

        let mut line = String::new();
        self.stdout
            .read_line(&mut line)
            .map_err(|error| format!("failed to read engine response: {error}"))?;

        if line.trim().is_empty() {
            return Err("engine returned an empty response".to_string());
        }

        let response: Value = serde_json::from_str(&line)
            .map_err(|error| format!("invalid engine JSON-RPC response: {error}; line={line}"))?;

        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("engine request failed")
                .to_string());
        }

        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn find_engine_executable() -> Option<PathBuf> {
    if let Ok(path) = env::var("AI_VIDEO_ENGINE_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    let repo_root = repo_root()?;

    let candidates = [
        repo_root.join("engine/build/Release/ai-video-engine.exe"),
        repo_root.join("engine/build/Debug/ai-video-engine.exe"),
        repo_root.join("engine/build/ai-video-engine.exe"),
        repo_root.join("engine/out/ai-video-engine.exe"),
    ];

    candidates.into_iter().find(|candidate| {
        fs::metadata(candidate)
            .map(|meta| meta.is_file())
            .unwrap_or(false)
    })
}

fn repo_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .parent()
        .map(PathBuf::from)
}
