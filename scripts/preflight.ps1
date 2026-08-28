<#
  IT Sentinel - pre-stage preflight. READ ONLY. Changes nothing.

  Run this on all 7 laptops in the last minute before you present. It re-runs
  the checks install-sentinel-agent.ps1 finished with, plus the ones that go
  stale between install time and demo time (agent died, hub moved, .env
  edited, someone rebooted and never logged back in).

  Exits 0 only if every check passes, so it can be driven from a loop.

  Usage:
    .\preflight.ps1
    .\preflight.ps1 -ControlPlaneUrl http://192.168.1.50:8787
#>
[CmdletBinding()]
param(
  # Overrides the URL in apps/agent-node/.env. Use it to check a hub the
  # machine has not been pointed at yet.
  [string]$ControlPlaneUrl
)

# Read-only script, but a check that throws must not be mistaken for a pass;
# every probe below catches its own errors and reports FAIL.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$EnvPath  = Join-Path $RepoRoot 'apps\agent-node\.env'
$VncRule  = 'IT Sentinel - TightVNC (TCP 5900)'
$KnownSlugs = @('nairobi-hq','lagos','dubai','london','singapore','sao-paulo','new-york')

$Results = New-Object System.Collections.Generic.List[object]

function Add-Result {
  param([string]$Status, [string]$Check, [string]$Detail)
  $Results.Add([PSCustomObject]@{ Status = $Status; Check = $Check; Detail = $Detail }) | Out-Null
}
function Add-Pass { param([string]$Check, [string]$Detail) Add-Result -Status 'PASS' -Check $Check -Detail $Detail }
function Add-Fail { param([string]$Check, [string]$Detail) Add-Result -Status 'FAIL' -Check $Check -Detail $Detail }
function Add-Warn { param([string]$Check, [string]$Detail) Add-Result -Status 'WARN' -Check $Check -Detail $Detail }
function Add-Info { param([string]$Check, [string]$Detail) Add-Result -Status 'INFO' -Check $Check -Detail $Detail }

function Get-ToolVersion {
  param([string]$Exe, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $out = (& $Exe @Arguments 2>&1 | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) { return $null }
    return ($out -split "`r?`n")[0].Trim()
  } catch {
    return $null
  } finally {
    $ErrorActionPreference = $prev
  }
}

function Get-PrimaryIPv4 {
  try {
    $cfg = Get-NetIPConfiguration -ErrorAction Stop |
      Where-Object { $_.IPv4DefaultGateway -and $_.NetAdapter.Status -eq 'Up' } |
      Where-Object { $_.InterfaceAlias -notmatch 'vEthernet|VirtualBox|VMware|Loopback|WSL|Tailscale|Hyper-V' }
    foreach ($c in $cfg) {
      $addr = $c.IPv4Address | Select-Object -First 1
      if ($addr) { return $addr.IPAddress }
    }
  } catch { }
  return $null
}

Write-Host ''
Write-Host ('  IT SENTINEL PREFLIGHT - ' + $env:COMPUTERNAME + ' - ' + (Get-Date -Format 'HH:mm:ss')) -ForegroundColor White

# ------------------------------------------------------------- .env ---

$envSlug = $null
$envUrl  = $null
if (Test-Path -LiteralPath $EnvPath) {
  Add-Pass '.env present' $EnvPath
  $lines = Get-Content -LiteralPath $EnvPath
  foreach ($line in $lines) {
    if ($line -match '^\s*SENTINEL_BRANCH_SLUG\s*=\s*(.+?)\s*$') { $envSlug = $Matches[1] }
    if ($line -match '^\s*CONTROL_PLANE_URL\s*=\s*(.+?)\s*$')    { $envUrl  = $Matches[1] }
  }
  if ([string]::IsNullOrWhiteSpace($envSlug)) {
    Add-Fail 'branch slug set' 'SENTINEL_BRANCH_SLUG is empty - this machine has no branch'
  } elseif ($KnownSlugs -notcontains $envSlug) {
    # Not fatal - the control plane may have other sites - but at a
    # seven-city demo it is nearly always a typo.
    Add-Warn 'branch slug set' ("'$envSlug' is not one of the 7 demo slugs")
  } else {
    Add-Pass 'branch slug set' $envSlug
  }
  if ([string]::IsNullOrWhiteSpace($envUrl)) {
    Add-Fail 'control plane URL set' 'CONTROL_PLANE_URL is empty'
  } else {
    Add-Pass 'control plane URL set' $envUrl
  }
} else {
  Add-Fail '.env present' "missing: $EnvPath - run install-sentinel-agent.ps1"
}

if (-not $ControlPlaneUrl) { $ControlPlaneUrl = $envUrl }
if ($ControlPlaneUrl) { $ControlPlaneUrl = $ControlPlaneUrl.Trim().TrimEnd('/') }

# -------------------------------------------------------- toolchain ---

foreach ($tool in @(
    @{ Name = 'node'; Args = @('-v') },
    @{ Name = 'pnpm'; Args = @('-v') },
    @{ Name = 'git';  Args = @('--version') })) {
  if (Get-Command $tool.Name -ErrorAction SilentlyContinue) {
    $v = Get-ToolVersion -Exe $tool.Name -Arguments $tool.Args
    if ($v) { Add-Pass ($tool.Name + ' present') $v }
    else    { Add-Fail ($tool.Name + ' present') 'on PATH but did not run' }
  } else {
    Add-Fail ($tool.Name + ' present') 'not on PATH'
  }
}

# The agent shells out to `pwsh`, never `powershell`. A machine with only
# Windows PowerShell looks healthy right up until the first command runs.
if (Get-Command pwsh -ErrorAction SilentlyContinue) {
  $v = Get-ToolVersion -Exe 'pwsh' -Arguments @('-v')
  if ($v -and $v -match 'PowerShell\s+7') { Add-Pass 'pwsh 7 works' $v }
  else { Add-Fail 'pwsh 7 works' ('unexpected output: ' + $v) }
} else {
  Add-Fail 'pwsh 7 works' 'pwsh not on PATH - the agent shells out to pwsh'
}

# ----------------------------------------------------------- vnc ---

$svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.Status -eq 'Running') { Add-Pass 'tvnserver service' 'running' }
  else { Add-Fail 'tvnserver service' ('status is ' + $svc.Status + ' - Start-Service tvnserver') }
} else {
  Add-Fail 'tvnserver service' 'service not installed'
}

$listening = $false
try {
  $listening = [bool](Test-NetConnection -ComputerName 'localhost' -Port 5900 `
    -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction Stop)
} catch { }
if ($listening) { Add-Pass 'port 5900 listening' 'localhost:5900 accepted a connection' }
else { Add-Fail 'port 5900 listening' 'nothing answered on 5900 - remote desktop will fail' }

# A listening port is not the same as a reachable one. The rule is what lets
# the relay in from another laptop.
$rule = Get-NetFirewallRule -DisplayName $VncRule -ErrorAction SilentlyContinue
if ($rule -and $rule.Enabled -eq 'True') {
  Add-Pass 'firewall rule 5900' $VncRule
} elseif ($rule) {
  Add-Fail 'firewall rule 5900' 'rule exists but is disabled'
} else {
  # Some other rule (the TightVNC installer's own) may still be allowing it,
  # so this is a warning rather than an outright failure.
  Add-Warn 'firewall rule 5900' "'$VncRule' not found - confirm 5900 is reachable from another laptop"
}

# --------------------------------------------------------- agent ---

$agent = $null
try {
  $agent = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'agent-node' } |
    Select-Object -First 1
} catch { }
if ($agent) {
  Add-Pass 'agent running' ('node.exe PID ' + $agent.ProcessId)
} else {
  Add-Fail 'agent running' 'no node process matching agent-node - start it from a normal terminal, NOT as a service'
}

# ---------------------------------------------------- control plane ---

if ($ControlPlaneUrl) {
  try {
    $health = Invoke-RestMethod -Uri ($ControlPlaneUrl + '/healthz') -TimeoutSec 8 -ErrorAction Stop
    if ($health -and $health.status -eq 'ok') {
      Add-Pass 'control plane /healthz' ($ControlPlaneUrl + ' -> ok')
    } else {
      Add-Fail 'control plane /healthz' 'answered without status=ok'
    }
  } catch {
    Add-Fail 'control plane /healthz' ($ControlPlaneUrl + ' -> ' + $_.Exception.Message)
  }
} else {
  Add-Fail 'control plane /healthz' 'no URL to test (.env missing CONTROL_PLANE_URL)'
}

# --------------------------------------------------------- lan ip ---

$ip = Get-PrimaryIPv4
if ($ip) { Add-Info 'primary LAN IPv4' ($ip + '  <- must match ipconfig and the agent log') }
else     { Add-Fail 'primary LAN IPv4' 'no adapter with a default gateway - is Wi-Fi connected?' }

# --------------------------------------------------------- table ---

$width = 0
foreach ($r in $Results) { if ($r.Check.Length -gt $width) { $width = $r.Check.Length } }

Write-Host ''
foreach ($r in $Results) {
  $color = 'Gray'
  if ($r.Status -eq 'PASS') { $color = 'Green' }
  if ($r.Status -eq 'FAIL') { $color = 'Red' }
  if ($r.Status -eq 'WARN') { $color = 'Yellow' }
  if ($r.Status -eq 'INFO') { $color = 'Cyan' }
  Write-Host ('  {0,-4}  {1}  {2}' -f $r.Status, $r.Check.PadRight($width), $r.Detail) -ForegroundColor $color
}

$failCount = ($Results | Where-Object { $_.Status -eq 'FAIL' }).Count
$warnCount = ($Results | Where-Object { $_.Status -eq 'WARN' }).Count

Write-Host ''
if ($failCount -eq 0) {
  $msg = '  READY' + $(if ($envSlug) { " - $envSlug" } else { '' })
  if ($warnCount -gt 0) { $msg = $msg + " ($warnCount warning(s), read them)" }
  Write-Host $msg -ForegroundColor Green
  Write-Host ''
  exit 0
} else {
  Write-Host ("  NOT READY - $failCount check(s) failed on $env:COMPUTERNAME") -ForegroundColor Red
  Write-Host ''
  exit 1
}
