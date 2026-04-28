Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildDir = Join-Path $repoRoot "engine/build"

if (-not (Test-Path (Join-Path $buildDir "CMakeCache.txt"))) {
  & "$PSScriptRoot/configure-engine.ps1"
}

cmake --build $buildDir --config Debug --target engine-core-tests
ctest --test-dir $buildDir --build-config Debug --output-on-failure
