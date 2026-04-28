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

## Windows Setup

Run these commands from PowerShell. The app targets Windows 11 and an RTX 30-series or newer NVIDIA GPU.

### 1. Install Base Tools

Install the tools used by the React/Tauri app and the C++ engine:

```powershell
winget install OpenJS.NodeJS
winget install Git.Git
winget install Kitware.CMake
winget install Rustlang.Rustup
winget install Gyan.FFmpeg
```

Install Visual Studio C++ tools. If Visual Studio Community is already installed, use the Visual Studio Installer and make sure **Desktop development with C++** is enabled.

For Build Tools only:

```powershell
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --quiet --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Restart PowerShell after installing system tools.

### 2. Install pnpm

Corepack works, but installing `pnpm` globally makes the repo scripts easier to run:

```powershell
corepack enable
corepack prepare pnpm@9.15.0 --activate
npm install -g pnpm@9.15.0
pnpm --version
```

### 3. Install vcpkg

The C++ engine uses CMake + vcpkg.

```powershell
$vcpkgRoot = Join-Path $env:USERPROFILE "vcpkg"
git clone https://github.com/microsoft/vcpkg.git $vcpkgRoot
Set-Location $vcpkgRoot
.\bootstrap-vcpkg.bat -disableMetrics
[Environment]::SetEnvironmentVariable("VCPKG_ROOT", $vcpkgRoot, "User")
$env:VCPKG_ROOT = $vcpkgRoot
.\vcpkg.exe version
```

If `C:\Users\<you>\vcpkg` already exists, skip the `git clone` line and run the rest.

### 4. Set Up FFmpeg

The app looks for FFmpeg in `tools/ffmpeg/bin` first, then `PATH`.

If FFmpeg is already installed at `C:\ffmpeg`, copy it into the repo:

```powershell
New-Item -ItemType Directory -Force -Path tools/ffmpeg/bin
Copy-Item C:\ffmpeg\bin\ffmpeg.exe tools/ffmpeg/bin\ffmpeg.exe -Force
Copy-Item C:\ffmpeg\bin\ffprobe.exe tools/ffmpeg/bin\ffprobe.exe -Force
Copy-Item C:\ffmpeg\bin\ffplay.exe tools/ffmpeg/bin\ffplay.exe -Force
```

If FFmpeg is only on `PATH`, the project will still work, but local `tools/ffmpeg/bin` keeps builds more reproducible.

Do not commit FFmpeg binaries.

### 5. Install Repo Dependencies

From the repo root:

```powershell
pnpm install
```

### 6. Verify the Machine

```powershell
powershell -ExecutionPolicy Bypass -File scripts/check-prereqs.ps1
```

Expected checks:

- Windows 11
- Node.js
- pnpm
- Rust/Cargo
- CMake
- Git
- vcpkg
- FFmpeg/FFprobe
- NVIDIA GPU
- RTX 30+ target

### 7. Configure and Build the Engine

```powershell
pnpm engine:configure
pnpm engine:build
pnpm engine:test
```

The engine executable is built at:

```text
engine/build/Debug/ai-video-engine.exe
```

You can check engine detection directly:

```powershell
.\engine\build\Debug\ai-video-engine.exe
```

### 8. Run Checks

```powershell
pnpm typecheck
pnpm test
cargo fmt --check --manifest-path apps/desktop/src-tauri/Cargo.toml
cargo check --manifest-path apps/desktop/src-tauri/Cargo.toml
```

### 9. Run the App in Development

```powershell
pnpm dev
```

This starts the Tauri desktop app. The React dev server runs at:

```text
http://127.0.0.1:1420
```

### 10. Build Installers

```powershell
pnpm build
```

Successful builds create:

```text
apps/desktop/src-tauri/target/release/bundle/msi/AI Video Editor_0.1.0_x64_en-US.msi
apps/desktop/src-tauri/target/release/bundle/nsis/AI Video Editor_0.1.0_x64-setup.exe
```

## Useful Commands

```powershell
pnpm setup
pnpm dev
pnpm build
pnpm typecheck
pnpm test
pnpm engine:configure
pnpm engine:build
pnpm engine:test
pnpm clean
```

## Troubleshooting

- If `pnpm` is not recognized, run `npm install -g pnpm@9.15.0`, then open a new PowerShell window.
- If CMake cannot find vcpkg, set `VCPKG_ROOT` to the vcpkg folder and reopen PowerShell.
- If FFmpeg is missing, put `ffmpeg.exe` and `ffprobe.exe` in `tools/ffmpeg/bin` or add them to `PATH`.
- If Tauri packaging fails on Windows, confirm `apps/desktop/src-tauri/icons/icon.ico` exists.
- If NVIDIA detection fails, confirm `nvidia-smi` works from PowerShell.

This repository currently contains the v0.1 foundation: the app shell, protocol package, Tauri bridge, C++ sidecar skeleton, scripts, and architecture docs.
