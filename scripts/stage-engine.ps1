param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Debug"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$engineOutput = Join-Path $repoRoot "engine/build/$Configuration"
$resourceDir = Join-Path $repoRoot "apps/desktop/src-tauri/resources"
$engineExecutable = Join-Path $engineOutput "ai-video-engine.exe"
$sqliteLibrary = Join-Path $engineOutput "sqlite3.dll"

if (-not (Test-Path $engineExecutable -PathType Leaf)) {
  throw "Engine executable is missing at $engineExecutable. Build the $Configuration engine first."
}
if (-not (Test-Path $sqliteLibrary -PathType Leaf)) {
  throw "Engine SQLite runtime is missing at $sqliteLibrary. Build the $Configuration engine first."
}

New-Item -ItemType Directory -Force -Path $resourceDir | Out-Null
Copy-Item -LiteralPath $engineExecutable -Destination (Join-Path $resourceDir "ai-video-engine.exe") -Force
Copy-Item -LiteralPath $sqliteLibrary -Destination (Join-Path $resourceDir "sqlite3.dll") -Force
