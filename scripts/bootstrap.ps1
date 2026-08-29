<#
  IT Sentinel - one-line bootstrap for a branch laptop.

  This is the FIRST thing you run on a fresh Windows machine that has
  nothing on it: no git, no Node, no pnpm. It fetches the code this laptop
  needs and then hands over to scripts\install-sentinel-agent.ps1, which is
  the script that actually sets the laptop up.

  It installs nothing except git, and it changes nothing else. Every
  decision about this machine is still made by install-sentinel-agent.ps1,
  behind its disclosure screen and its INSTALL prompt.

  Usage - paste ONE of these into PowerShell:

    # simplest; the installer prompts for branch and hub URL
    irm https://it-sentinel-control-plane.onrender.com/v1/enroll/bootstrap.ps1 | iex

    # same thing, but passing arguments through to the installer. This is
    # the form the enrollment page at /enroll generates for you.
    & ([scriptblock]::Create((irm https://it-sentinel-control-plane.onrender.com/v1/enroll/bootstrap.ps1))) -BranchSlug lagos -ControlPlaneUrl https://it-sentinel-control-plane.onrender.com

    # from a copy on a USB stick or a network share (no internet needed)
    powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\bootstrap.ps1

  Safe to run twice. A second run updates the copy already on disk.

  ---------------------------------------------------------------------
  WHERE THIS SCRIPT COMES FROM, AND WHERE THE CODE COMES FROM

  Two different questions, with two different answers.

  This SCRIPT is served by the control plane, at /v1/enroll/bootstrap.ps1,
  rather than from raw.githubusercontent.com. Three reasons, in order of how
  much they matter on the day: it is the same origin as everything else the
  laptop has to reach, so one firewall rule covers enrollment and operation;
  it serves the scripts belonging to the DEPLOYED control plane rather than
  whatever happens to be on main; and it keeps working if the repo's
  visibility ever changes again. (It was private until recently, which broke
  the raw-GitHub one-liner outright.)

  The CODE is cloned from GitHub, because the repo is public and a clone is
  the plainest, most inspectable thing that works - it leaves a real working
  copy that anyone can `git pull`, `git log` or `git diff` afterwards, which
  a downloaded archive does not.

  When the clone cannot happen - github.com blocked by venue wifi is the
  realistic one - this falls back to /v1/enroll/repo.zip on the control
  plane and carries on. It downloads one archive rather than fetching the
  .ps1 files one at a time because install-sentinel-agent.ps1 is not
  standalone: it runs `pnpm install` at the repo root and starts the agent
  from source under apps\agent-node, so four loose scripts would get this
  laptop three steps into an install before it discovered there was nothing
  to install.

  -UseControlPlane skips straight to that fallback and needs no git at all.
  ---------------------------------------------------------------------
#>
[CmdletBinding()]
param(
  # Forwarded verbatim to install-sentinel-agent.ps1. See that script.
  [string]$BranchSlug,
  [string]$ControlPlaneUrl,
  [string]$VncPassword,

  # Where the repo is cloned from. Public, so no GitHub sign-in is needed.
  #
  # A local path works here too: -RepoUrl D:\it-sentinel clones off a USB
  # stick, -RepoUrl \\HUB\share\it-sentinel clones off a network share.
  [string]$RepoUrl = 'https://github.com/imodoiepale/it-sentinel.git',

  # Branch to clone. Empty means "whatever the repo's default branch is".
  [string]$Branch = '',

  # Control plane origin used for the no-GitHub fallback. Not a file URL;
  # /v1/enroll/repo.zip is appended.
  #
  # Defaults to -ControlPlaneUrl when you passed one, so a branch pointed at
  # an on-prem or LAN hub falls back to that same hub rather than to the
  # internet. The hosted default is used only when neither is given.
  [string]$SourceUrl,

  # Skip git entirely and take the control-plane archive. What to reach for
  # when you already know github.com is unreachable from this network.
  [switch]$UseControlPlane,

  # Where the working copy lands.
  [string]$InstallRoot = (Join-Path $env:USERPROFILE 'it-sentinel'),

  # Fetch only; do not run the installer afterwards.
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

# Used only when neither -SourceUrl nor -ControlPlaneUrl was given.
$DefaultSourceUrl = 'https://it-sentinel-control-plane.onrender.com'

# ------------------------------------------------------------- output ---

function Write-Head($text) {
  Write-Host ''
  Write-Host ('== ' + $text + ' ' + ('=' * [Math]::Max(4, 68 - $text.Length))) -ForegroundColor Cyan
}
function Write-Ok($text)   { Write-Host ('  [ ok ] ' + $text) -ForegroundColor Green }
function Write-Skip($text) { Write-Host ('  [skip] ' + $text) -ForegroundColor DarkGray }
function Write-Warn($text) { Write-Host ('  [warn] ' + $text) -ForegroundColor Yellow }
function Write-Info($text) { Write-Host ('  [ .. ] ' + $text) }

# Every failure exit goes through here, so a teammate standing at a strange
# laptop always gets a named problem and a next action instead of a red
# PowerShell stack trace.
function Stop-Bootstrap {
  param([string]$Problem, [string[]]$Fix)
  Write-Host ''
  Write-Host ('  [FAIL] ' + $Problem) -ForegroundColor Red
  Write-Host ''
  Write-Host '  What to do:' -ForegroundColor Yellow
  foreach ($line in $Fix) { Write-Host ('    ' + $line) -ForegroundColor Yellow }
  Write-Host ''
  exit 1
}

# ------------------------------------------------------------ helpers ---
# Deliberately the same shapes as install-sentinel-agent.ps1: same elevation
# test, same host-exe lookup, same PATH refresh. Two different answers to
# "am I admin?" on one machine is how you get a demo that works on five
# laptops and not on the other two.

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  return (New-Object Security.Principal.WindowsPrincipal($id)).IsInRole(
    [Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Get-HostExe {
  $p = (Get-Process -Id $PID).Path
  if ([string]::IsNullOrWhiteSpace($p)) { $p = Join-Path $PSHOME 'powershell.exe' }
  return $p
}

function Test-CommandExists {
  param([string]$Name)
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

# winget puts git on the *machine* PATH; this process still has the PATH it
# started with. Without this the post-install probe fails on a machine where
# the install actually worked.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

# git and winget write ordinary progress to stderr, which Windows PowerShell
# 5.1 turns into a terminating NativeCommandError under
# $ErrorActionPreference='Stop'. Relax it only around the call and judge the
# result by the exit code.
function Invoke-Native {
  param([string]$File, [string[]]$Arguments)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    & $File @Arguments 2>&1 | ForEach-Object { Write-Host ('         ' + $_) -ForegroundColor DarkGray }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

# Windows PowerShell 5.1 on an un-patched machine still offers TLS 1.0
# first, which every modern host refuses. Harmless where 1.2 is already the
# default, and the difference between a download and a bewildering
# "underlying connection was closed" where it is not.
function Enable-Tls12 {
  try {
    [Net.ServicePointManager]::SecurityProtocol =
      [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
  } catch { }
}

# ------------------------------------------------------- code sources ---
# Both return $true on success and $false on a failure the caller can still
# recover from. Neither exits: choosing when to give up is the caller's job,
# because "git did not work" is only fatal once the fallback has also failed.

function Install-Git {
  if (Test-CommandExists 'git') {
    Write-Skip 'git already present.'
    return $true
  }

  Write-Info 'git is not installed on this machine.'

  if (-not (Test-CommandExists 'winget')) {
    Write-Warn 'git is missing and winget is not available to install it.'
    return $false
  }

  $wingetArgs = @('install', '-e', '--id', 'Git.Git', '--silent',
                  '--accept-source-agreements', '--accept-package-agreements')

  if (Test-Elevated) {
    Write-Info 'Installing git via winget ...'
    Invoke-Native -File 'winget' -Arguments $wingetArgs | Out-Null
  } else {
    # Only the winget call is elevated, in a short-lived child process.
    # This script stays unelevated on purpose, so the clone lands in the
    # profile of the person actually standing at the laptop and uses their
    # git config. install-sentinel-agent.ps1 does its own elevation later,
    # after its consent screen - which is where the elevation for this
    # machine belongs.
    Write-Info 'Installing git needs administrator. Windows will show a UAC prompt now.'
    Write-Info 'Approve it; a window opens, installs git, and closes by itself.'
    $childArgs = '-NoProfile -ExecutionPolicy Bypass -Command "winget ' + ($wingetArgs -join ' ') + '"'
    try {
      Start-Process -FilePath (Get-HostExe) -ArgumentList $childArgs -Verb RunAs -Wait | Out-Null
    } catch {
      Write-Warn ('git could not be installed: ' + $_.Exception.Message)
      return $false
    }
  }

  Update-SessionPath
  if (-not (Test-CommandExists 'git')) {
    Write-Warn 'git still is not available after the install attempt.'
    return $false
  }
  Write-Ok 'git installed and verified.'
  return $true
}

function Get-RepoByGit {
  param([string]$Destination)

  Write-Head 'GIT'
  if (-not (Install-Git)) { return $false }

  Write-Head 'REPO (git clone)'
  Write-Info ('Cloning ' + $RepoUrl)
  Write-Info ('     to ' + $Destination)

  $cloneArgs = @('clone')
  if ($Branch) { $cloneArgs += @('--branch', $Branch) }
  $cloneArgs += @($RepoUrl, $Destination)

  $code = Invoke-Native -File 'git' -Arguments $cloneArgs
  if (($code -ne 0) -or -not (Test-Path -LiteralPath (Join-Path $Destination '.git'))) {
    Write-Warn ('Could not clone ' + $RepoUrl + ' (git exit ' + $code + ').')
    # git leaves a partial directory behind on a failed clone, and
    # Expand-Archive would then unpack the fallback on top of it.
    if ((Test-Path -LiteralPath $Destination) -and
        -not (Test-Path -LiteralPath (Join-Path $Destination 'scripts\install-sentinel-agent.ps1'))) {
      Remove-Item -LiteralPath $Destination -Recurse -Force -ErrorAction SilentlyContinue
    }
    return $false
  }

  Write-Ok 'Repo cloned.'
  return $true
}

function Get-RepoByArchive {
  param([string]$Destination)

  Write-Head 'REPO (control plane)'
  $archiveUrl  = $SourceUrl + '/v1/enroll/repo.zip'
  $archivePath = Join-Path ([IO.Path]::GetTempPath()) ('it-sentinel-' + [Guid]::NewGuid().ToString('N') + '.zip')

  Write-Info ('Downloading ' + $archiveUrl)
  Write-Info ('        to ' + $Destination)

  Enable-Tls12

  # Invoke-WebRequest in Windows PowerShell 5.1 renders a progress bar by
  # repainting the console for every chunk, which turns a two-second
  # download into a thirty-second one. Suppressed for the duration only.
  $prevProgress = $ProgressPreference
  $ProgressPreference = 'SilentlyContinue'
  try {
    Invoke-WebRequest -Uri $archiveUrl -OutFile $archivePath -UseBasicParsing -TimeoutSec 120
  } catch {
    Write-Warn ('Could not download ' + $archiveUrl)
    Write-Warn ('  ' + $_.Exception.Message)
    return $false
  } finally {
    $ProgressPreference = $prevProgress
  }

  try {
    # -Force so a re-run refreshes the files this archive ships and leaves
    # everything else - node_modules, apps\agent-node\.env - untouched.
    Expand-Archive -LiteralPath $archivePath -DestinationPath $Destination -Force
  } catch {
    Write-Warn ('Downloaded the code but could not unpack it into ' + $Destination)
    Write-Warn ('  ' + $_.Exception.Message)
    return $false
  } finally {
    Remove-Item -LiteralPath $archivePath -Force -ErrorAction SilentlyContinue
  }

  Write-Ok ('Agent code unpacked into ' + $Destination)
  return $true
}

# --------------------------------------------------------------- start ---

Write-Host ''
Write-Host '  IT SENTINEL - bootstrap' -ForegroundColor White
Write-Host '  -----------------------' -ForegroundColor White
Write-Host "  Machine : $env:COMPUTERNAME"
Write-Host "  User    : $env:USERDOMAIN\$env:USERNAME"
Write-Host ''
Write-Host '  This fetches the agent code and then runs the real installer, which'
Write-Host '  tells you exactly what it collects and what it changes, and waits'
Write-Host '  for you to type INSTALL before it touches anything.'

if (-not $SourceUrl) {
  if ($ControlPlaneUrl) { $SourceUrl = $ControlPlaneUrl } else { $SourceUrl = $DefaultSourceUrl }
}
$SourceUrl = $SourceUrl.TrimEnd('/')

# --------------------------------------------------- 1. already local? ---
# If this file is sitting inside a checkout already - a USB stick, a network
# share, the machine you developed on - use that checkout. Fetching over the
# top of it would be slower, would need the network, and would leave the
# operator staring at a second copy wondering which one is live.

$LocalRepo = ''
if ($PSCommandPath) {
  $candidate = Split-Path -Parent (Split-Path -Parent $PSCommandPath)
  if ($candidate -and (Test-Path -LiteralPath (Join-Path $candidate 'scripts\install-sentinel-agent.ps1'))) {
    $LocalRepo = $candidate
  }
}

if ($LocalRepo -and -not $PSBoundParameters.ContainsKey('InstallRoot')) {

  Write-Head 'REPO'
  Write-Ok ('Running from inside a checkout already: ' + $LocalRepo)
  Write-Skip 'Nothing to fetch. Pass -InstallRoot to fetch a fresh copy elsewhere instead.'
  $RepoDir = $LocalRepo

} else {

  $RepoDir = $InstallRoot
  $installerHere = Test-Path -LiteralPath (Join-Path $RepoDir 'scripts\install-sentinel-agent.ps1')

  if (Test-Path -LiteralPath (Join-Path $RepoDir '.git')) {

    # ------------------------------------------------ 2a. re-run, clone ---
    Write-Head 'REPO'
    Write-Info ('Existing checkout found at ' + $RepoDir + '; updating it.')
    if (Test-CommandExists 'git') {
      $code = Invoke-Native -File 'git' -Arguments @('-C', $RepoDir, 'pull', '--ff-only')
      if ($code -ne 0) {
        # Not fatal, on purpose. On a network with no GitHub, or with local
        # edits in the way, the copy already on disk is still perfectly good
        # to install from - and getting to the installer is the point.
        Write-Warn 'git pull failed. Continuing with the copy already on disk.'
        Write-Warn 'If you were expecting new changes, sort the pull out and re-run this.'
      } else {
        Write-Ok 'Repo updated.'
      }
    } else {
      Write-Warn 'git is not on PATH, so this checkout cannot be updated. Continuing with it as it is.'
    }

  } elseif ($installerHere) {

    # ----------------------------------------------- 2b. re-run, archive ---
    Write-Head 'REPO'
    Write-Info ('Existing copy found at ' + $RepoDir + '; refreshing it from the control plane.')
    if (-not (Get-RepoByArchive -Destination $RepoDir)) {
      Write-Warn 'Refresh failed. Continuing with the copy already on disk.'
    }

  } elseif ((Test-Path -LiteralPath $RepoDir) -and
            (Get-ChildItem -LiteralPath $RepoDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {

    Stop-Bootstrap -Problem ($RepoDir + ' already exists, has files in it, and is not an IT Sentinel copy.') -Fix @(
      'Rename or delete that folder and paste the one-liner again, or install',
      'somewhere else by adding:',
      '  -InstallRoot C:\it-sentinel')

  } else {

    # -------------------------------------------------- 2c. first fetch ---
    # git first because the repo is public and a clone leaves a working copy
    # that can be inspected and updated later; the control-plane archive is
    # the answer to a network that blocks github.com, which is a real thing
    # on locked-down venue wifi.

    $got = $false
    if (-not $UseControlPlane) {
      $got = Get-RepoByGit -Destination $RepoDir
      if (-not $got) { Write-Info 'Falling back to the control plane, which needs no git and no GitHub.' }
    }
    if (-not $got) { $got = Get-RepoByArchive -Destination $RepoDir }

    if (-not $got) {
      # Name only the sources actually tried. Blaming GitHub for a failure on
      # a run that never touched it sends the reader off in the wrong
      # direction, which is the one thing this message exists to avoid.
      $tried = if ($UseControlPlane) { 'the control plane' } else { 'GitHub or the control plane' }
      Stop-Bootstrap -Problem ('Could not get the agent code from ' + $tried + '.') -Fix @(
        'Check, in this order:',
        ('  - is this laptop online?  Try:  irm ' + $SourceUrl + '/healthz'),
        '  - is that the right hub address? Pass the right one with',
        '      -SourceUrl https://your-hub.example.com',
        '  - is the hub itself up? A free-tier host can take ~50s to wake from',
        '    idle, so waiting a minute and re-running is worth one attempt.',
        '',
        'No network at all? Copy the it-sentinel folder onto a USB stick and run',
        '',
        '  powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\install-sentinel-agent.ps1',
        '',
        'That is the same installer this script was about to run for you.')
    }
  }
}

# --------------------------------------------------------- 3. hand off ---

$Installer = Join-Path $RepoDir 'scripts\install-sentinel-agent.ps1'
if (-not (Test-Path -LiteralPath $Installer)) {
  Stop-Bootstrap -Problem 'The code is here but the installer script is not in it.' -Fix @(
    'The branch you fetched does not carry scripts/. Re-run with:',
    '  -Branch main',
    'or delete the folder and re-run with -UseControlPlane, which always',
    'serves the scripts belonging to the deployed control plane.',
    '',
    ('Looked for: ' + $Installer))
}

# Anything that arrived as a downloaded archive rather than a clone comes
# with mark-of-the-web on every file, and PowerShell then refuses to run
# them. Scoped to the two folders holding .ps1 files we execute, because a
# recursive pass over node_modules on a re-run takes minutes.
foreach ($dir in @('scripts', 'apps\agent-node')) {
  $target = Join-Path $RepoDir $dir
  if (-not (Test-Path -LiteralPath $target)) { continue }
  try {
    Get-ChildItem -LiteralPath $target -Filter '*.ps1' -Recurse -File -ErrorAction SilentlyContinue |
      Where-Object { $_.FullName -notlike '*\node_modules\*' } |
      Unblock-File -ErrorAction SilentlyContinue
  } catch { }
}

if ($NoInstall) {
  Write-Head 'DONE (-NoInstall was passed)'
  Write-Host ('  Code is ready at ' + $RepoDir)
  Write-Host '  Run the installer yourself when you are ready:'
  Write-Host ('    ' + $Installer)
  Write-Host ''
  exit 0
}

Write-Head 'HANDING OVER TO THE INSTALLER'
Write-Host '  Everything from here is install-sentinel-agent.ps1. It shows you what'
Write-Host '  it collects and waits for you to type INSTALL.'

# Splatted, not string-concatenated: a hub URL or a password containing a
# space or a quote survives this intact, and the password is never printed.
$forward = @{}
if ($BranchSlug)      { $forward['BranchSlug']      = $BranchSlug }
if ($ControlPlaneUrl) { $forward['ControlPlaneUrl'] = $ControlPlaneUrl }
if ($VncPassword)     { $forward['VncPassword']     = $VncPassword }

$shown = @()
if ($BranchSlug)      { $shown += ('-BranchSlug ' + $BranchSlug) }
if ($ControlPlaneUrl) { $shown += ('-ControlPlaneUrl ' + $ControlPlaneUrl) }
if ($VncPassword)     { $shown += '-VncPassword <hidden>' }
if ($shown.Count -gt 0) { Write-Info ('Forwarding: ' + ($shown -join ' ')) }

Set-Location -LiteralPath $RepoDir

$global:LASTEXITCODE = 0
& $Installer @forward
$rc = $LASTEXITCODE
if ($null -eq $rc) { $rc = 0 }
exit $rc
