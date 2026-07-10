param(
  [ValidateSet("Debug", "Release")]
  [string]$Configuration = "Debug"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$buildDir = Join-Path $repoRoot "engine/build"
$sourceDir = (Resolve-Path (Join-Path $repoRoot "engine")).Path
$cachePath = Join-Path $buildDir "CMakeCache.txt"

if (Test-Path $cachePath) {
  $cachedSourceLine = Select-String -Path $cachePath -Pattern '^CMAKE_HOME_DIRECTORY:INTERNAL=(.+)$' | Select-Object -First 1
  $cachedSource = if ($cachedSourceLine) { $cachedSourceLine.Matches[0].Groups[1].Value } else { "" }
  if ($cachedSource -and -not [string]::Equals([IO.Path]::GetFullPath($cachedSource), [IO.Path]::GetFullPath($sourceDir), [StringComparison]::OrdinalIgnoreCase)) {
    $resolvedRepo = [IO.Path]::GetFullPath($repoRoot.Path).TrimEnd('\')
    $resolvedBuild = [IO.Path]::GetFullPath($buildDir).TrimEnd('\')
    if (-not $resolvedBuild.StartsWith($resolvedRepo + '\', [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove an engine build cache outside the repository: $resolvedBuild"
    }
    Remove-Item -LiteralPath $resolvedBuild -Recurse -Force
  }
}

if (-not (Test-Path $cachePath)) {
  & "$PSScriptRoot/configure-engine.ps1"
}

cmake --build $buildDir --config $Configuration --target ai-video-engine
if ($LASTEXITCODE -ne 0) {
  exit $LASTEXITCODE
}
