Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$localBin = Join-Path $repoRoot "tools/ffmpeg/bin"
$localFfmpeg = Join-Path $localBin "ffmpeg.exe"
$localFfprobe = Join-Path $localBin "ffprobe.exe"

if ((Test-Path $localFfmpeg) -and (Test-Path $localFfprobe)) {
  Write-Host "FFmpeg OK - $localBin"
  exit 0
}

$pathFfmpeg = Get-Command "ffmpeg" -ErrorAction SilentlyContinue
$pathFfprobe = Get-Command "ffprobe" -ErrorAction SilentlyContinue

if ($pathFfmpeg -and $pathFfprobe) {
  Write-Host "FFmpeg OK - using PATH"
  Write-Host "ffmpeg:  $($pathFfmpeg.Source)"
  Write-Host "ffprobe: $($pathFfprobe.Source)"
  exit 0
}

Write-Warning "FFmpeg was not found. Place ffmpeg.exe and ffprobe.exe in tools/ffmpeg/bin or add them to PATH."
exit 1
