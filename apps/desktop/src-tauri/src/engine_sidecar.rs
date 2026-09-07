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
        let exe = find_engine_executable().ok_or_else(|| {
            "could not find the bundled ai-video-engine.exe; reinstall the app or run pnpm dev from a complete checkout"
                .to_string()
        })?;
        let engine_dir = exe
            .parent()
            .map(PathBuf::from)
            .ok_or_else(|| "engine executable has no parent directory".to_string())?;
        let source_root = repo_root().filter(|path| path.is_dir());
        let working_dir = source_root.as_ref().unwrap_or(&engine_dir);
        let source_ffmpeg_dir = source_root
            .as_ref()
            .map(|path| path.join("tools/ffmpeg/bin"));
        let ffmpeg_dir = source_ffmpeg_dir
            .filter(|path| path.is_dir())
            .unwrap_or_else(|| engine_dir.join("tools/ffmpeg/bin"));

        let mut command = Command::new(&exe);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .arg("--stdio")
            .current_dir(working_dir)
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

    pub fn is_running(&mut self) -> Result<bool, String> {
        self.child
            .try_wait()
            .map(|status| status.is_none())
            .map_err(|error| format!("failed to inspect engine sidecar: {error}"))
    }

    pub fn stop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

pub(crate) fn find_engine_executable() -> Option<PathBuf> {
    if let Ok(path) = env::var("AI_VIDEO_ENGINE_PATH") {
        let candidate = PathBuf::from(path);
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    engine_executable_candidates(repo_root(), env::current_exe().ok())
        .into_iter()
        .find(|candidate| {
            fs::metadata(candidate)
                .map(|meta| meta.is_file())
                .unwrap_or(false)
        })
}

fn engine_executable_candidates(
    source_root: Option<PathBuf>,
    desktop_executable: Option<PathBuf>,
) -> Vec<PathBuf> {
    let mut candidates = Vec::new();

    // A previous package build can leave an old sidecar beside the dev executable.
    // Development from this checkout must run the freshly built Debug engine.
    if cfg!(debug_assertions) {
        if let (Some(root), Some(executable)) = (&source_root, &desktop_executable) {
            if executable.starts_with(root.join("apps/desktop/src-tauri/target")) {
                candidates.push(root.join("engine/build/Debug/ai-video-engine.exe"));
            }
        }
    }

    if let Some(desktop_dir) = desktop_executable.and_then(|path| path.parent().map(PathBuf::from))
    {
        candidates.push(desktop_dir.join("ai-video-engine.exe"));
        candidates.push(desktop_dir.join("resources/ai-video-engine.exe"));
    }

    if let Some(source_root) = source_root {
        candidates.extend([
            source_root.join(if cfg!(debug_assertions) {
                "engine/build/Debug/ai-video-engine.exe"
            } else {
                "engine/build/Release/ai-video-engine.exe"
            }),
            source_root.join(if cfg!(debug_assertions) {
                "engine/build/Release/ai-video-engine.exe"
            } else {
                "engine/build/Debug/ai-video-engine.exe"
            }),
            source_root.join("engine/build/ai-video-engine.exe"),
            source_root.join("engine/out/ai-video-engine.exe"),
        ]);
    }

    candidates
}

fn repo_root() -> Option<PathBuf> {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()?
        .parent()?
        .parent()
        .map(PathBuf::from)
}

#[cfg(test)]
mod tests {
    use super::engine_executable_candidates;
    use std::path::PathBuf;

    #[test]
    fn development_prefers_fresh_engine_over_stale_packaged_copy() {
        if !cfg!(debug_assertions) {
            return;
        }
        let candidates = engine_executable_candidates(
            Some(PathBuf::from(r"C:\source\VideoEditor")),
            Some(PathBuf::from(
                r"C:\source\VideoEditor\apps\desktop\src-tauri\target\debug\ai-video-editor-desktop.exe",
            )),
        );
        assert_eq!(
            candidates[0],
            PathBuf::from(r"C:\source\VideoEditor\engine\build\Debug\ai-video-engine.exe")
        );
    }

    #[test]
    fn packaged_engine_locations_are_checked_before_checkout_builds() {
        let candidates = engine_executable_candidates(
            Some(PathBuf::from(r"C:\source\VideoEditor")),
            Some(PathBuf::from(
                r"C:\Program Files\AI Video Editor\AI Video Editor.exe",
            )),
        );

        assert_eq!(
            candidates[0],
            PathBuf::from(r"C:\Program Files\AI Video Editor\ai-video-engine.exe")
        );
        assert_eq!(
            candidates[1],
            PathBuf::from(r"C:\Program Files\AI Video Editor\resources\ai-video-engine.exe")
        );
        assert_eq!(
            candidates[2],
            PathBuf::from(if cfg!(debug_assertions) {
                r"C:\source\VideoEditor\engine\build\Debug\ai-video-engine.exe"
            } else {
                r"C:\source\VideoEditor\engine\build\Release\ai-video-engine.exe"
            })
        );
    }

    #[test]
    fn packaged_engine_locations_work_without_a_checkout() {
        let candidates = engine_executable_candidates(
            None,
            Some(PathBuf::from(r"C:\Apps\Editor\AI Video Editor.exe")),
        );

        assert_eq!(candidates.len(), 2);
        assert_eq!(
            candidates[1],
            PathBuf::from(r"C:\Apps\Editor\resources\ai-video-engine.exe")
        );
    }
}
