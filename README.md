# AI Video Editor

A Windows-first video editor prototype with a simple React/Tauri surface and a C++ editor engine sidecar underneath.

The v0.1 goal is a clean manual editor that can grow into an AI-ready professional engine:

- React + TypeScript UI
- Tauri desktop shell
- C++ engine sidecar
- JSON-RPC command channel
- Folder-based projects
- SQLite project data
- FFmpeg/NVIDIA-oriented media pipeline
- Plugin-ready command system

## Development

Prerequisites:

- Windows 11
- Node.js 20+
- pnpm 9+
- Rust stable
- Visual Studio Build Tools with C++ workload
- CMake
- vcpkg
- FFmpeg in `tools/ffmpeg/bin` or on `PATH`

Useful commands:

```powershell
pnpm setup
pnpm dev
pnpm engine:configure
pnpm engine:build
pnpm typecheck
pnpm test
```

This repository currently contains the v0.1 foundation: the app shell, protocol package, Tauri bridge, C++ sidecar skeleton, scripts, and architecture docs.
