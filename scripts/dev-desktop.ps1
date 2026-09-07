Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

& "$PSScriptRoot/build-engine.ps1" -Configuration Debug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
& "$PSScriptRoot/stage-engine.ps1" -Configuration Debug
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
corepack pnpm --filter @ai-video-editor/desktop tauri dev
