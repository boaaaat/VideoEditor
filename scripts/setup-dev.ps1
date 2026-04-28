Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
Set-Location $repoRoot

if (-not (Get-Command pnpm -ErrorAction SilentlyContinue)) {
  if (Get-Command corepack -ErrorAction SilentlyContinue) {
    corepack enable
  } else {
    throw "pnpm is required. Install Node.js 20+ with corepack, then run corepack enable."
  }
}

corepack pnpm install
& "$PSScriptRoot/check-prereqs.ps1"
