Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildDir = Join-Path $repoRoot "engine/build"
$cmakeArgs = @("-S", (Join-Path $repoRoot "engine"), "-B", $buildDir)

$vcpkgRoot = $env:VCPKG_ROOT
if (-not $vcpkgRoot -and (Get-Command vcpkg -ErrorAction SilentlyContinue)) {
  $vcpkgRoot = Split-Path (Get-Command vcpkg).Source -Parent
}

$toolchain = if ($vcpkgRoot) { Join-Path $vcpkgRoot "scripts/buildsystems/vcpkg.cmake" } else { "" }
if (-not $toolchain -or -not (Test-Path $toolchain)) {
  throw "vcpkg toolchain was not found. Set VCPKG_ROOT to the vcpkg folder before configuring the C++ engine."
}

$cmakeArgs += "-DCMAKE_TOOLCHAIN_FILE=$toolchain"
cmake @cmakeArgs
