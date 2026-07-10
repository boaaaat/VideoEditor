Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

& "$PSScriptRoot/build-engine.ps1" -Configuration Debug
& "$PSScriptRoot/stage-engine.ps1" -Configuration Debug
corepack pnpm --filter @ai-video-editor/desktop tauri dev
