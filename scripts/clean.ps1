Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$repoRoot = Resolve-Path (Join-Path $PSScriptRoot "..")
$targets = @(
  (Join-Path $repoRoot "engine/build"),
  (Join-Path $repoRoot "apps/desktop/dist"),
  (Join-Path $repoRoot "apps/desktop/src-tauri/target")
)

foreach ($target in $targets) {
  $resolvedRoot = [System.IO.Path]::GetFullPath($repoRoot)
  $fullTarget = [System.IO.Path]::GetFullPath($target)
  if ($fullTarget.StartsWith($resolvedRoot) -and (Test-Path $fullTarget)) {
    Remove-Item -LiteralPath $fullTarget -Recurse -Force
    Write-Host "Removed $fullTarget"
  }
}
