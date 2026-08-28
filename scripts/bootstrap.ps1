<#
  IT Sentinel - one-line bootstrap for a branch laptop.

  This is the FIRST thing you run on a fresh Windows machine that has
  nothing on it: no git, no Node, no pnpm. It does the three boring steps
  that used to be done by hand - install git, clone the repo, find the
  installer - and then hands over to scripts\install-sentinel-agent.ps1,
  which is the script that actually sets the laptop up.

  It installs nothing except git, and it changes nothing else. Every
  decision about this machine is still made by install-sentinel-agent.ps1,
  behind its disclosure screen and its INSTALL prompt.

  Usage - paste ONE of these into PowerShell:

    # simplest; the installer prompts for branch and hub URL
    irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1 | iex

    # same thing, but passing arguments through to the installer
    & ([scriptblock]::Create((irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1))) -BranchSlug lagos

    # from a copy on a USB stick or a network share (no GitHub needed)
    powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\bootstrap.ps1

  Safe to run twice. A second run pulls instead of cloning.
#>
[CmdletBinding()]
param(
  # Forwarded verbatim to install-sentinel-agent.ps1. See that script.
  [string]$BranchSlug,
  [string]$ControlPlaneUrl,
  [string]$VncPassword,

  # Where the repo is cloned from.
  #
  # This default is the real `git remote -v` of this working copy, not a
  # guess. Two things must be true before the one-liner above works for a
  # teammate:
  #   1. scripts/ has to exist on the branch being fetched - as of writing
  #      it is on a feature branch, not on main, and
  #   2. the repo has to be reachable by whoever runs it - today it is
  #      PRIVATE, so an unauthenticated laptop gets a 404.
  # If neither is true on demo day, use the USB / network-share fallback in
  # docs/15-hackathon-demo-runbook.md section 1. It needs no GitHub at all.
  #
  # A local path works here too: -RepoUrl D:\it-sentinel clones off a USB
  # stick, -RepoUrl \\HUB\share\it-sentinel clones off a network share.
  [string]$RepoUrl = 'https://github.com/imodoiepale/it-sentinel.git',

  # Branch to clone. Empty means "whatever the repo's default branch is".
  [string]$Branch = '',

  # Where the working copy lands.
  [string]$InstallRoot = (Join-Path $env:USERPROFILE 'it-sentinel'),

  # Clone or pull only; do not run the installer afterwards.
  [switch]$NoInstall
)

$ErrorActionPreference = 'Stop'

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

# --------------------------------------------------------------- start ---

Write-Host ''
Write-Host '  IT SENTINEL - bootstrap' -ForegroundColor White
Write-Host '  -----------------------' -ForegroundColor White
Write-Host "  Machine : $env:COMPUTERNAME"
Write-Host "  User    : $env:USERDOMAIN\$env:USERNAME"
Write-Host ''
Write-Host '  This installs git (only git), fetches the repo, and then runs the'
Write-Host '  real installer, which tells you exactly what it collects and waits'
Write-Host '  for you to type INSTALL before it touches anything.'

# --------------------------------------------------- 1. already local? ---
# If this file is sitting inside a checkout already - a USB stick, a network
# share, the machine you developed on - use that checkout. Cloning over the
# top of it would be slower, would need GitHub, and would leave the operator
# staring at a second copy of the repo wondering which one is live.

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
  Write-Skip 'Nothing to clone. Pass -InstallRoot to clone a fresh copy elsewhere instead.'
  $RepoDir = $LocalRepo

} else {

  # ------------------------------------------------------------ 2. git ---

  Write-Head 'GIT'

  if (Test-CommandExists 'git') {
    Write-Skip 'git already present.'
  } else {
    Write-Info 'git is not installed on this machine.'

    if (-not (Test-CommandExists 'winget')) {
      Stop-Bootstrap -Problem 'git is missing and winget is not available to install it.' -Fix @(
        'Install "App Installer" from the Microsoft Store - that is what provides',
        'winget - then paste the one-liner again.',
        '',
        'Or install git by hand from https://git-scm.com/download/win , open a NEW',
        'PowerShell window, and paste the one-liner again.')
    }

    $wingetArgs = @('install', '-e', '--id', 'Git.Git', '--silent',
                    '--accept-source-agreements', '--accept-package-agreements')

    if (Test-Elevated) {
      Write-Info 'Installing git via winget ...'
      Invoke-Native -File 'winget' -Arguments $wingetArgs | Out-Null
    } else {
      # Only the winget call is elevated, in a short-lived child process.
      # This script stays unelevated on purpose, so the clone lands in the
      # profile of the person actually standing at the laptop and uses
      # their git config. install-sentinel-agent.ps1 does its own
      # elevation later, after its consent screen - which is where the
      # elevation for this machine belongs.
      Write-Info 'Installing git needs administrator. Windows will show a UAC prompt now.'
      Write-Info 'Approve it; a window opens, installs git, and closes by itself.'
      $childArgs = '-NoProfile -ExecutionPolicy Bypass -Command "winget ' + ($wingetArgs -join ' ') + '"'
      try {
        Start-Process -FilePath (Get-HostExe) -ArgumentList $childArgs -Verb RunAs -Wait | Out-Null
      } catch {
        Stop-Bootstrap -Problem 'UAC was declined, so git could not be installed. Nothing was changed.' -Fix @(
          'Paste the one-liner again and click Yes on the UAC prompt, or',
          'sign in with an account that has local administrator rights on this laptop.',
          '',
          ('(' + $_.Exception.Message + ')'))
      }
    }

    Update-SessionPath
    if (-not (Test-CommandExists 'git')) {
      Stop-Bootstrap -Problem 'git still is not available after the install attempt.' -Fix @(
        'Open PowerShell as Administrator and run:',
        '  winget install -e --id Git.Git',
        'then open a NEW PowerShell window and paste the one-liner again.',
        '',
        'A NEW window matters: this one still has the PATH it started with.')
    }
    Write-Ok 'git installed and verified.'
  }

  # ----------------------------------------------------------- 3. repo ---

  Write-Head 'REPO'
  $RepoDir = $InstallRoot
  Write-Info ('Working copy goes to ' + $RepoDir)

  if (Test-Path -LiteralPath (Join-Path $RepoDir '.git')) {

    # Re-run. Update in place rather than failing on "directory exists".
    Write-Info ('Existing checkout found at ' + $RepoDir + '; updating it.')
    $code = Invoke-Native -File 'git' -Arguments @('-C', $RepoDir, 'pull', '--ff-only')
    if ($code -ne 0) {
      # Not fatal, on purpose. On a venue network with no GitHub, or with
      # local edits in the way, the copy already on disk is still perfectly
      # good to install from - and getting to the installer is the point.
      Write-Warn 'git pull failed. Continuing with the copy already on disk.'
      Write-Warn 'If you were expecting new changes, sort the pull out and re-run this.'
    } else {
      Write-Ok 'Repo updated.'
    }

  } elseif ((Test-Path -LiteralPath $RepoDir) -and
            (Get-ChildItem -LiteralPath $RepoDir -Force -ErrorAction SilentlyContinue | Select-Object -First 1)) {

    Stop-Bootstrap -Problem ($RepoDir + ' already exists, has files in it, and is not a git checkout.') -Fix @(
      'Rename or delete that folder and paste the one-liner again, or clone',
      'somewhere else by adding:',
      '  -InstallRoot C:\it-sentinel')

  } else {

    Write-Info ('Cloning ' + $RepoUrl)
    Write-Info ('     to ' + $RepoDir)
    $cloneArgs = @('clone')
    if ($Branch) { $cloneArgs += @('--branch', $Branch) }
    $cloneArgs += @($RepoUrl, $RepoDir)
    $code = Invoke-Native -File 'git' -Arguments $cloneArgs
    if (($code -ne 0) -or -not (Test-Path -LiteralPath (Join-Path $RepoDir '.git'))) {
      Stop-Bootstrap -Problem ('Could not clone ' + $RepoUrl) -Fix @(
        'Most likely one of these:',
        '  - the repo is PRIVATE and this laptop is not signed in to GitHub',
        '  - the venue network blocks github.com',
        '  - the branch does not exist (try without -Branch, or -Branch main)',
        '',
        'The fallback that needs no GitHub at all: copy the it-sentinel folder',
        'onto a USB stick or a network share, plug it in, and run',
        '',
        '  powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\install-sentinel-agent.ps1',
        '',
        'That is the same installer this script was about to run for you.')
    }
    Write-Ok 'Repo cloned.'
  }
}

# --------------------------------------------------------- 4. hand off ---

$Installer = Join-Path $RepoDir 'scripts\install-sentinel-agent.ps1'
if (-not (Test-Path -LiteralPath $Installer)) {
  Stop-Bootstrap -Problem 'The repo is here but the installer script is not in it.' -Fix @(
    'The branch you fetched does not carry scripts/. Re-run with:',
    '  -Branch main',
    'or delete the folder and re-run against a branch that has scripts/ on it.',
    '',
    ('Looked for: ' + $Installer))
}

# A copy that arrived as a downloaded .zip rather than a clone comes with
# mark-of-the-web on every file, and PowerShell then refuses to run them.
try {
  Get-ChildItem -LiteralPath (Join-Path $RepoDir 'scripts') -Filter '*.ps1' -ErrorAction SilentlyContinue |
    Unblock-File -ErrorAction SilentlyContinue
} catch { }

if ($NoInstall) {
  Write-Head 'DONE (-NoInstall was passed)'
  Write-Host ('  Repo is ready at ' + $RepoDir)
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
