Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

corepack pnpm --filter @ai-video-editor/protocol typecheck
& "$PSScriptRoot/build-engine.ps1"
corepack pnpm --filter @ai-video-editor/desktop tauri build
