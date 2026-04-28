Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

function Test-Command($Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Write-Check($Name, $Ok, $Detail = "") {
  $mark = if ($Ok) { "OK" } else { "MISSING" }
  $line = "{0,-24} {1}" -f $Name, $mark
  if ($Detail) { $line = "$line - $Detail" }
  Write-Host $line
}

$isWindows11 = [System.Environment]::OSVersion.Version.Build -ge 22000
Write-Check "Windows 11" $isWindows11 ([System.Environment]::OSVersion.VersionString)

foreach ($tool in @("node", "rustc", "cargo", "cmake", "git")) {
  $exists = Test-Command $tool
  $detail = if ($exists) { (& $tool --version 2>$null | Select-Object -First 1) } else { "" }
  Write-Check $tool $exists $detail
}

$pnpmExists = Test-Command "pnpm"
$pnpmDetail = ""
if ($pnpmExists) {
  $pnpmDetail = (pnpm --version 2>$null | Select-Object -First 1)
} elseif (Test-Command "corepack") {
  $pnpmExists = $true
  $pnpmDetail = "via corepack $(corepack pnpm --version 2>$null | Select-Object -First 1)"
}
Write-Check "pnpm" $pnpmExists $pnpmDetail

$vcpkgRoot = $env:VCPKG_ROOT
$hasVcpkg = ($vcpkgRoot -and (Test-Path (Join-Path $vcpkgRoot "scripts/buildsystems/vcpkg.cmake"))) -or (Test-Command "vcpkg")
Write-Check "vcpkg" $hasVcpkg $(if ($vcpkgRoot) { $vcpkgRoot } else { "set VCPKG_ROOT for best results" })

& "$PSScriptRoot/setup-ffmpeg.ps1"

$nvidiaSmi = Test-Command "nvidia-smi"
$gpuName = ""
if ($nvidiaSmi) {
  $gpuName = (nvidia-smi --query-gpu=name --format=csv,noheader 2>$null | Select-Object -First 1)
}
$isRtx30Plus = $gpuName -match "RTX (30|40|50|A|PRO)"
Write-Check "NVIDIA GPU" $nvidiaSmi $gpuName
Write-Check "RTX 30+ target" $isRtx30Plus $gpuName

if (-not $isWindows11) {
  exit 1
}
