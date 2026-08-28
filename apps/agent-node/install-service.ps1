<#
  Installs agent-node as a Windows Service running as LocalSystem. Run this
  once, elevated, on each branch machine after `pnpm build` has produced
  dist/main.js. This is what gives the agent its elevated, no-UAC,
  survives-reboot execution context — see the plan's "How elevation is
  obtained" table.

  Usage: .\install-service.ps1 -BranchSlug junction-mall -BranchName "Junction Mall" -ControlPlaneUrl https://control.it-sentinel.internal
#>
param(
  [Parameter(Mandatory=$true)][string]$BranchSlug,
  [Parameter(Mandatory=$true)][string]$BranchName,
  [Parameter(Mandatory=$true)][string]$ControlPlaneUrl
)

$ErrorActionPreference = 'Stop'
$serviceName = 'ITSentinelAgent'
$installDir = 'C:\Program Files\IT Sentinel\agent-node'

if (-not (Test-Path $installDir)) {
  New-Item -ItemType Directory -Path $installDir -Force | Out-Null
}
Copy-Item -Path (Join-Path $PSScriptRoot 'dist\*') -Destination $installDir -Recurse -Force
Copy-Item -Path (Join-Path $PSScriptRoot 'src\collect.ps1') -Destination $installDir -Force

[Environment]::SetEnvironmentVariable('CONTROL_PLANE_URL', $ControlPlaneUrl, 'Machine')
[Environment]::SetEnvironmentVariable('SENTINEL_BRANCH_SLUG', $BranchSlug, 'Machine')
[Environment]::SetEnvironmentVariable('SENTINEL_BRANCH_NAME', $BranchName, 'Machine')

# node-windows registers the actual Windows Service wrapper (see
# package.json's "install-service" script, which node-windows' Service
# class runs once on first install) — this file only stages files and
# machine-scoped env vars ahead of that.
Write-Host "Staged agent-node at $installDir for branch $BranchName. Run 'node dist/service-install.js' from that directory to register the Windows Service (LocalSystem, auto-start)."
