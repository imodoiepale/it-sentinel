<#
  IT Sentinel - one-shot branch laptop setup for the hackathon demo.

  Run this ONCE per laptop. It automates sections 1 and 4 of
  docs/15-hackathon-demo-runbook.md: prerequisites, TightVNC + its firewall
  hole, apps/agent-node/.env, and starting the agent.

  It tells you everything it is about to do - including exactly what the
  agent collects from this machine - and refuses to move until you type
  INSTALL. These are people's personal laptops; a silent install is not an
  option.

  Usage:
    .\install-sentinel-agent.ps1
    .\install-sentinel-agent.ps1 -ControlPlaneUrl http://192.168.1.50:8787 -BranchSlug lagos

  Safe to run twice. Everything it does checks first.
#>
[CmdletBinding()]
param(
  # Hub address, e.g. http://192.168.1.50:8787 . Prompted for if omitted.
  [string]$ControlPlaneUrl,

  # One of the seven demo slugs. A numbered menu appears if omitted.
  [string]$BranchSlug,

  # TightVNC primary password. Prompted for (hidden) if omitted.
  # See "VNC password" below for what this can and cannot guarantee.
  [string]$VncPassword,

  # --- internal: set by the self-elevation relaunch, do not pass by hand ---
  [switch]$ConsentAccepted,
  [switch]$Relaunched,
  [string]$InvokingUser
)

# Stop on the first unhandled error rather than limping onward and printing a
# success banner over a half-finished install. Native commands (winget, pnpm)
# do not honour this, so they are wrapped in Invoke-Native below and their
# outcome is judged by probing the machine, never by their exit code.
$ErrorActionPreference = 'Stop'

$RepoRoot   = Split-Path -Parent $PSScriptRoot
$AgentDir   = Join-Path $RepoRoot 'apps\agent-node'
$EnvPath    = Join-Path $AgentDir '.env'
$VncRule    = 'IT Sentinel - TightVNC (TCP 5900)'
$Failures   = New-Object System.Collections.Generic.List[string]

# Slugs and display names come from packages/db/seed/003_bootstrap_demo.sql.
# If that seed changes, this list has to change with it - a slug typo here
# produces a machine that heartbeats into a branch nobody is watching.
$Branches = @(
  @{ Slug = 'nairobi-hq'; Name = 'Nairobi HQ' },
  @{ Slug = 'lagos';      Name = 'Lagos' },
  @{ Slug = 'dubai';      Name = 'Dubai' },
  @{ Slug = 'london';     Name = 'London' },
  @{ Slug = 'singapore';  Name = 'Singapore' },
  @{ Slug = 'sao-paulo';  Name = 'Sao Paulo' },
  @{ Slug = 'new-york';   Name = 'New York' }
)

# --------------------------------------------------------------- helpers ---

function Write-Head($text) {
  Write-Host ''
  Write-Host ('== ' + $text + ' ' + ('=' * [Math]::Max(4, 68 - $text.Length))) -ForegroundColor Cyan
}
function Write-Ok($text)   { Write-Host ('  [ ok ] ' + $text) -ForegroundColor Green }
function Write-Skip($text) { Write-Host ('  [skip] ' + $text) -ForegroundColor DarkGray }
function Write-Warn($text) { Write-Host ('  [warn] ' + $text) -ForegroundColor Yellow }
function Write-Info($text) { Write-Host ('  [ .. ] ' + $text) }
function Write-Fail($text, $fix) {
  Write-Host ('  [FAIL] ' + $text) -ForegroundColor Red
  $Failures.Add($text + "`n         fix: " + $fix) | Out-Null
}

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

# Native tools write to stderr for perfectly ordinary progress messages, and
# under $ErrorActionPreference='Stop' Windows PowerShell 5.1 turns that into a
# terminating NativeCommandError. Relax the preference only around the call.
function Invoke-Native {
  param([string]$File, [string[]]$Arguments, [switch]$Quiet)
  $prev = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) {
      & $File @Arguments 2>&1 | Out-Null
    } else {
      & $File @Arguments 2>&1 | ForEach-Object { Write-Host ('         ' + $_) -ForegroundColor DarkGray }
    }
    return $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $prev
  }
}

# A winget install puts new directories on the *machine* PATH; this process
# still has the PATH it started with. Without this, every post-install probe
# fails on a machine where the install actually worked fine.
function Update-SessionPath {
  $machine = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $user    = [Environment]::GetEnvironmentVariable('Path', 'User')
  $env:Path = ($machine, $user | Where-Object { $_ }) -join ';'
}

function Test-CommandExists {
  param([string]$Name)
  $c = Get-Command $Name -ErrorAction SilentlyContinue
  return [bool]$c
}

function Get-TightVncExe {
  foreach ($p in @(
      "$env:ProgramFiles\TightVNC\tvnserver.exe",
      "${env:ProgramFiles(x86)}\TightVNC\tvnserver.exe")) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

function Test-ChromeInstalled {
  $reg = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe'
  if (Test-Path $reg) { return $true }
  foreach ($p in @(
      "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
      "${env:ProgramFiles(x86)}\Google\Chrome\Application\chrome.exe")) {
    if ($p -and (Test-Path -LiteralPath $p)) { return $true }
  }
  return $false
}

# The relay dials this address to reach TightVNC, and the agent reports it in
# every heartbeat. Prefer the interface that owns the default route, and skip
# the virtual adapters (Hyper-V, WSL, VirtualBox, VMware, Tailscale) that
# otherwise win the race on a developer laptop.
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
  try {
    $a = Get-NetIPAddress -AddressFamily IPv4 -ErrorAction Stop |
      Where-Object { $_.IPAddress -ne '127.0.0.1' -and $_.IPAddress -notlike '169.254.*' } |
      Select-Object -First 1
    if ($a) { return $a.IPAddress }
  } catch { }
  return $null
}

function Test-PortListening {
  param([string]$ComputerName, [int]$Port)
  try {
    return [bool](Test-NetConnection -ComputerName $ComputerName -Port $Port `
      -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction Stop)
  } catch { return $false }
}

function ConvertFrom-SecureStringPlain {
  param([System.Security.SecureString]$Secure)
  $bstr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($Secure)
  try { return [Runtime.InteropServices.Marshal]::PtrToStringBSTR($bstr) }
  finally { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($bstr) }
}

# The password reaches TightVNC as an msiexec property on a command line.
# A double quote or a space breaks that quoting, and the failure mode is a
# TightVNC with a password nobody knows. Refuse both rather than guess.
# The password itself is never printed, only a description of the problem.
function Test-VncPasswordUsable {
  param([string]$Password)
  if ([string]::IsNullOrEmpty($Password)) { return $true }
  if ($Password.Contains('"') -or $Password.Contains(' ')) {
    Write-Warn 'The VNC password contains a space or a double quote.'
    Write-Warn 'Neither survives the MSI command line, so it will NOT be set programmatically.'
    Write-Warn 'Either choose a password without them, or set it in the TightVNC UI (instructions below).'
    return $false
  }
  return $true
}

# ------------------------------------------------- 1. explain, then ask ---

Write-Host ''
Write-Host '  IT SENTINEL - branch laptop setup' -ForegroundColor White
Write-Host '  ---------------------------------' -ForegroundColor White
Write-Host "  Machine : $env:COMPUTERNAME"
Write-Host "  User    : $env:USERDOMAIN\$env:USERNAME"
Write-Host "  Repo    : $RepoRoot"

Write-Head 'WHAT THIS SCRIPT WILL INSTALL (via winget, system-wide)'
Write-Host @'
    Node.js LTS, PowerShell 7, Git, TightVNC Server, Google Chrome.
    pnpm (via npm) if it is missing.
    Anything already present is left alone.
'@

Write-Head 'WHAT IT WILL CHANGE ON THIS MACHINE'
Write-Host @"
    Firewall : one INBOUND allow rule, TCP port 5900 (TightVNC).
               This lets any machine on the network you are joined to reach
               this laptop's remote-desktop port. On venue Wi-Fi that is
               every stranger in the room. Remove it when the demo is over:
                 Remove-NetFirewallRule -DisplayName '$VncRule'
    Service  : TightVNC Server set to start automatically and started now.
    Files    : $EnvPath  (overwritten; the old one is kept as .env.bak)
               a Startup-folder shortcut so the agent starts at logon
               node_modules/ under the repo, if pnpm install has not run
    Running  : the agent is started now, in your desktop session.
"@

Write-Head 'WHAT THE AGENT COLLECTS FROM THIS MACHINE'
Write-Host @'
    Every 15 seconds it sends a heartbeat to the control plane containing:

      Hardware      hostname, LAN IP, MAC, serial, model, manufacturer,
                    CPU model/usage/temperature, RAM installed/free and the
                    top 10 processes by memory, every disk volume with free
                    space and SMART health, battery/UPS state
      Windows       version, build, activation status, uptime, pending
                    reboot, pending/failed Windows Update counts
      Network       LAN or Wi-Fi, gateway, DNS servers, latency, packet
                    loss, link speed, whether the internet is reachable,
                    and this machine's public IP
      Security      antivirus product name, whether it is running, how old
                    its definitions are, last scan time, firewall profiles
      Printers      every installed printer: name, driver, port, queue
                    depth, error state
      Software      the list of installed applications and their versions
      Services      the running/stopped state of monitored Windows services
      Event log     up to 50 recent critical/error/warning entries,
                    INCLUDING their message text
      Email         whether an email client is installed, whether a profile
                    is configured, whether the server is reachable, and how
                    many send/receive errors occurred
      You           the logged-in username, whether the session is active,
                    locked or idle, and for how long

    It does NOT collect email message contents - the heartbeat contract has
    no field for them and says so in a comment - and it does not log
    keystrokes, read your files, or capture your screen on a timer.

    Two things it CAN do on demand, which you should know about:
      - An operator on the dashboard can dispatch commands that run on this
        machine (restart a service, launch an allow-listed app).
      - An operator can open a TightVNC session and see and control this
        desktop live. That is the point of installing TightVNC. It is not
        silent - TightVNC shows a tray icon - but assume that during the
        demo somebody can watch this screen.

    Sign out of anything personal before the demo, or use a spare machine.
'@

if ($ConsentAccepted) {
  Write-Host ''
  Write-Host '  Consent was given in the window that launched this one.' -ForegroundColor DarkGray
} else {
  Write-Host ''
  Write-Host '  Type INSTALL (capitals) to proceed. Anything else aborts.' -ForegroundColor Yellow
  $answer = Read-Host '  >'
  if ($answer -cne 'INSTALL') {
    Write-Host ''
    Write-Host '  Aborted. Nothing was installed or changed.' -ForegroundColor Yellow
    exit 1
  }
}

# Checked here, before UAC, so a bad password is not discovered halfway
# through an elevated install.
if ($VncPassword -and -not (Test-VncPasswordUsable -Password $VncPassword)) {
  $VncPassword = ''
  Write-Warn 'Continuing without a programmatic password; set it in the TightVNC UI.'
}

# ------------------------------------------------------- 2. elevation ---

if (-not (Test-Elevated)) {
  Write-Head 'ADMINISTRATOR RIGHTS NEEDED'
  Write-Host @'
    This session is not elevated. Three of the steps cannot work without it:
      - winget installs these packages system-wide (Program Files, HKLM)
      - TightVNC Server is a Windows service; registering and starting a
        service requires administrator
      - the inbound firewall rule for port 5900 is a machine-wide change

    Windows will now show a UAC prompt. Approve it and this script continues
    in a new elevated window; the work happens there.
'@

  # Built as ONE string rather than an array: Start-Process joins an array
  # with spaces and does not add quoting, so a repo path containing a space
  # would silently split into two arguments.
  $relaunch = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ConsentAccepted -Relaunched -InvokingUser "{1}"' `
                -f $PSCommandPath, $env:USERNAME
  if ($ControlPlaneUrl) { $relaunch += (' -ControlPlaneUrl "{0}"' -f $ControlPlaneUrl) }
  if ($BranchSlug)      { $relaunch += (' -BranchSlug "{0}"'      -f $BranchSlug) }
  if ($VncPassword) {
    # Forwarded on the command line, which is visible in this machine's
    # process list for the lifetime of the elevated process. Omit
    # -VncPassword and the elevated window prompts for it privately instead.
    Write-Warn 'The VNC password is being forwarded on the command line and is briefly visible in the process list.'
    $relaunch += (' -VncPassword "{0}"' -f $VncPassword)
  }

  try {
    $p = Start-Process -FilePath (Get-HostExe) -ArgumentList $relaunch -Verb RunAs -PassThru -Wait
    exit $p.ExitCode
  } catch {
    Write-Host ''
    Write-Host '  UAC was declined (or elevation failed), so nothing has been installed.' -ForegroundColor Red
    Write-Host '  Nothing on this machine was changed. To continue you need either:' -ForegroundColor Red
    Write-Host '    - to run this again and click Yes on the UAC prompt, or' -ForegroundColor Red
    Write-Host '    - an account with local administrator rights on this laptop.' -ForegroundColor Red
    Write-Host ('  (' + $_.Exception.Message + ')') -ForegroundColor DarkGray
    exit 1
  }
}

Write-Head 'ELEVATION'
Write-Ok "Running elevated as $env:USERDOMAIN\$env:USERNAME."

# The Startup shortcut lands in whichever profile this elevated session
# belongs to. Same-user UAC keeps that correct; entering a *different* admin
# account's credentials silently puts the shortcut in the wrong profile.
if ($InvokingUser -and ($InvokingUser -ne $env:USERNAME)) {
  Write-Warn "Elevated as '$env:USERNAME' but launched by '$InvokingUser'."
  Write-Warn "The logon shortcut will be created for '$env:USERNAME', not '$InvokingUser'."
}

# --------------------------------------------------------- 3. packages ---

Write-Head 'PREREQUISITES'

if (-not (Test-CommandExists 'winget')) {
  Write-Host '  winget is not available on this machine.' -ForegroundColor Red
  Write-Host '  Install "App Installer" from the Microsoft Store, then re-run this script.' -ForegroundColor Red
  exit 1
}
Write-Ok 'winget present.'

# Each entry probes for the real artefact afterwards. winget exits 0 in
# several cases where nothing usable landed - an already-installed-elsewhere
# match, a source it decided to skip, an MSI that rolled itself back - so its
# exit code is logged and then ignored.
$packages = @(
  @{ Id = 'OpenJS.NodeJS.LTS';  Label = 'Node.js LTS';   Probe = { Test-CommandExists 'node' } },
  @{ Id = 'Microsoft.PowerShell'; Label = 'PowerShell 7'; Probe = { Test-CommandExists 'pwsh' } },
  @{ Id = 'Git.Git';            Label = 'Git';           Probe = { Test-CommandExists 'git' } },
  @{ Id = 'Google.Chrome';      Label = 'Google Chrome'; Probe = { Test-ChromeInstalled } }
)

foreach ($pkg in $packages) {
  if (& $pkg.Probe) {
    Write-Skip ($pkg.Label + ' already present.')
    continue
  }
  Write-Info ('Installing ' + $pkg.Label + ' (' + $pkg.Id + ') ...')
  # --source winget is not optional. Without it winget also negotiates with
  # the msstore source, which prints a geographic-region agreement, adds a
  # round trip before anything downloads, and can resolve to the Store build
  # of a package instead of the MSI. On venue wifi that turns a slow install
  # into one that looks hung. Pinning the source makes which artifact gets
  # installed deterministic as well as faster.
  #
  # --disable-interactivity so a package that wants to prompt fails loudly
  # rather than blocking forever behind a window nobody is watching.
  $code = Invoke-Native -File 'winget' -Arguments @(
    'install', '-e', '--id', $pkg.Id, '--silent', '--source', 'winget',
    '--disable-interactivity',
    '--accept-source-agreements', '--accept-package-agreements')
  Update-SessionPath
  if (& $pkg.Probe) {
    Write-Ok ($pkg.Label + ' installed and verified.')
  } else {
    Write-Fail ($pkg.Label + " did not verify after install (winget exit $code).") `
      ("Install it by hand: winget install -e --id " + $pkg.Id + " ; then open a NEW terminal and re-run this script.")
  }
}

# TightVNC is handled separately because the password can only be set during
# the MSI install, and because it needs a service + firewall rule afterwards.
Write-Head 'TIGHTVNC'

$vncExe = Get-TightVncExe
if ($vncExe) {
  Write-Skip "TightVNC already installed at $vncExe."
  if ($VncPassword) {
    Write-Warn 'A password was supplied, but TightVNC is already installed and the password can only be set during install.'
  }
  $passwordAttempted = $false
} else {
  if (-not $VncPassword) {
    Write-Host '  TightVNC primary password (input hidden; use the SAME password on all 7 laptops):'
    $secure = Read-Host '  >' -AsSecureString
    $VncPassword = ConvertFrom-SecureStringPlain -Secure $secure
  }
  if (-not (Test-VncPasswordUsable -Password $VncPassword)) { $VncPassword = '' }
  if ([string]::IsNullOrEmpty($VncPassword)) {
    Write-Warn 'No password given. TightVNC will install without one and you must set it in the UI.'
    $passwordAttempted = $false
    $code = Invoke-Native -File 'winget' -Arguments @(
      'install', '-e', '--id', 'GlavSoft.TightVNC', '--silent',
      '--source', 'winget', '--disable-interactivity',
    '--accept-source-agreements', '--accept-package-agreements')
  } else {
    # TightVNC's documented silent-install MSI properties. Passed through
    # winget's --custom, which APPENDS to msiexec's arguments (--override
    # would replace winget's own, including /qn). Output is suppressed so the
    # password cannot land in this console; note that it is still an msiexec
    # command line, so it is visible in the process list while installing.
    Write-Info 'Installing TightVNC with the password set via MSI properties (output suppressed).'
    $passwordAttempted = $true
    $custom = 'SET_USEVNCAUTHENTICATION=1 VALUE_OF_USEVNCAUTHENTICATION=1 ' +
              'SET_PASSWORD=1 VALUE_OF_PASSWORD=' + $VncPassword + ' ' +
              'SET_USECONTROLAUTHENTICATION=1 VALUE_OF_USECONTROLAUTHENTICATION=0'
    $code = Invoke-Native -Quiet -File 'winget' -Arguments @(
      'install', '-e', '--id', 'GlavSoft.TightVNC', '--silent',
      '--accept-source-agreements', '--accept-package-agreements',
      '--custom', $custom)
  }
  Update-SessionPath
  $vncExe = Get-TightVncExe
  if ($vncExe) {
    Write-Ok "TightVNC installed and verified at $vncExe."
  } else {
    Write-Fail "TightVNC did not verify after install (winget exit $code)." `
      'Install it by hand from https://www.tightvnc.com/download.php, tick "Register as service" and set the password, then re-run this script.'
  }
}

# Service must be running, or port 5900 never opens no matter what the
# firewall says.
$svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
if ($svc) {
  if ($svc.StartType -ne 'Automatic') {
    try {
      Set-Service -Name 'tvnserver' -StartupType Automatic
      Write-Ok 'TightVNC service set to start automatically.'
    } catch {
      Write-Fail ('Could not set tvnserver to automatic start: ' + $_.Exception.Message) `
        'Set it in services.msc, or the agent will be blind to VNC after the next reboot.'
    }
  } else {
    Write-Skip 'TightVNC service already set to automatic.'
  }
  if ($svc.Status -ne 'Running') {
    try {
      Start-Service -Name 'tvnserver'
      Write-Ok 'TightVNC service started.'
    } catch {
      Write-Fail ('Could not start tvnserver: ' + $_.Exception.Message) `
        'Try: Start-Service tvnserver ; check the Application event log if it refuses.'
    }
  } else {
    Write-Skip 'TightVNC service already running.'
  }
} elseif ($vncExe) {
  Write-Fail 'TightVNC is installed but the tvnserver service does not exist.' `
    'Re-run the TightVNC installer and tick "Register TightVNC Server as a system service".'
}

# The single most common reason remote desktop dies at demo time: the
# installer's firewall checkbox was missed. Add the rule explicitly rather
# than hoping the installer did it. Idempotent by DisplayName.
$existingRule = Get-NetFirewallRule -DisplayName $VncRule -ErrorAction SilentlyContinue
if ($existingRule) {
  Write-Skip "Firewall rule '$VncRule' already exists."
} else {
  try {
    New-NetFirewallRule -DisplayName $VncRule -Direction Inbound -Action Allow `
      -Protocol TCP -LocalPort 5900 -Profile Domain,Private,Public `
      -Description 'IT Sentinel demo. Delete after the demo.' | Out-Null
    Write-Ok "Firewall rule '$VncRule' created (inbound TCP 5900, all profiles)."
    Write-Warn 'Port 5900 is now reachable from the whole local network, venue Wi-Fi included.'
    Write-Warn ("Remove it afterwards: Remove-NetFirewallRule -DisplayName '" + $VncRule + "'")
  } catch {
    Write-Fail ('Could not create the firewall rule: ' + $_.Exception.Message) `
      ("Add it by hand: netsh advfirewall firewall add rule name=""" + $VncRule + """ dir=in action=allow protocol=TCP localport=5900")
  }
}

# Be honest about the password. Setting it via MSI properties usually works,
# but this script cannot read the stored value back and compare it - TightVNC
# keeps it obfuscated in the registry - so it reports only whether SOME
# password exists, and says the rest out loud.
$pwdSet = $false
try {
  foreach ($key in @('HKLM:\SOFTWARE\TightVNC\Server', 'HKLM:\SOFTWARE\WOW6432Node\TightVNC\Server')) {
    if (Test-Path $key) {
      $prop = Get-ItemProperty -Path $key -Name 'Password' -ErrorAction SilentlyContinue
      if ($prop -and $prop.Password) { $pwdSet = $true }
    }
  }
} catch { }

Write-Host ''
if ($pwdSet -and $passwordAttempted) {
  Write-Ok 'A TightVNC primary password is stored in the registry.'
  Write-Warn 'This script CANNOT verify it matches what you typed. Test it with a VNC client before the demo.'
} elseif ($pwdSet) {
  Write-Warn 'A TightVNC password is already stored, but this script did not set it. Confirm it is the shared demo password.'
} else {
  Write-Warn 'NO TightVNC password is set. Remote desktop will not work until you set one.'
}
Write-Host @'
    Set or confirm it by hand - 30 seconds, and worth doing on every laptop:
      right-click the TightVNC tray icon (or Start > TightVNC Server -
      Offline Configuration) > Configuration > Server tab >
      Authentication > "Require VNC authentication" ticked >
      Primary password > Change... > type the SHARED demo password > OK.
    The same password must be on all 7 laptops and in the seeded credential
    (runbook step 2.4).
'@

# ------------------------------------------------------------ 4. pnpm ---

Write-Head 'PNPM'
if (Test-CommandExists 'pnpm') {
  Write-Skip 'pnpm already present.'
} elseif (Test-CommandExists 'npm') {
  Write-Info 'Installing pnpm globally via npm ...'
  $code = Invoke-Native -File 'npm' -Arguments @('install', '-g', 'pnpm')
  Update-SessionPath
  if (Test-CommandExists 'pnpm') {
    Write-Ok 'pnpm installed and verified.'
  } else {
    Write-Fail "pnpm did not verify after install (npm exit $code)." `
      'Run: npm install -g pnpm  in a NEW terminal, then re-run this script.'
  }
} else {
  Write-Fail 'npm is not available, so pnpm cannot be installed.' `
    'Fix the Node.js install first, open a NEW terminal, then re-run this script.'
}

# ------------------------------------------------ 5. branch and .env ---

Write-Head 'BRANCH'

$chosen = $null
if ($BranchSlug) {
  $chosen = $Branches | Where-Object { $_.Slug -eq $BranchSlug } | Select-Object -First 1
  if (-not $chosen) {
    Write-Host ("  '" + $BranchSlug + "' is not one of the seven demo slugs.") -ForegroundColor Red
    Write-Host ('  Valid: ' + (($Branches | ForEach-Object { $_.Slug }) -join ', ')) -ForegroundColor Red
    exit 1
  }
  Write-Ok ('Branch from -BranchSlug: ' + $chosen.Name + ' (' + $chosen.Slug + ')')
} else {
  Write-Host '  Which branch is this laptop? Two laptops sharing a slug report as one branch.'
  Write-Host ''
  for ($i = 0; $i -lt $Branches.Count; $i++) {
    Write-Host ('    {0}) {1,-12} {2}' -f ($i + 1), $Branches[$i].Slug, $Branches[$i].Name)
  }
  Write-Host ''
  while (-not $chosen) {
    $pick = Read-Host '  Number (1-7)'
    $n = 0
    if ([int]::TryParse($pick, [ref]$n) -and $n -ge 1 -and $n -le $Branches.Count) {
      $chosen = $Branches[$n - 1]
    } else {
      Write-Host '  Enter a number from 1 to 7.' -ForegroundColor Yellow
    }
  }
  Write-Ok ('Branch: ' + $chosen.Name + ' (' + $chosen.Slug + ')')
}

if (-not $ControlPlaneUrl) {
  Write-Host ''
  Write-Host '  Control plane URL - the hub laptop, e.g. http://192.168.1.50:8787'
  Write-Host '  (find it with ipconfig on the hub; localhost only works ON the hub)'
  $ControlPlaneUrl = Read-Host '  URL [http://localhost:8787]'
  if ([string]::IsNullOrWhiteSpace($ControlPlaneUrl)) { $ControlPlaneUrl = 'http://localhost:8787' }
}
$ControlPlaneUrl = $ControlPlaneUrl.Trim().TrimEnd('/')
if ($ControlPlaneUrl -notmatch '^https?://') {
  Write-Host "  '$ControlPlaneUrl' is not an http(s) URL." -ForegroundColor Red
  exit 1
}
Write-Ok "Control plane: $ControlPlaneUrl"

Write-Head 'AGENT CONFIG'

$envBody = @"
# Written by scripts/install-sentinel-agent.ps1 on $(Get-Date -Format 'yyyy-MM-dd HH:mm').
# Slugs: nairobi-hq | lagos | dubai | london | singapore | sao-paulo | new-york
CONTROL_PLANE_URL=$ControlPlaneUrl
HEARTBEAT_INTERVAL_MS=15000
COMMAND_POLL_INTERVAL_MS=3000
SENTINEL_BRANCH_SLUG=$($chosen.Slug)
SENTINEL_BRANCH_NAME=$($chosen.Name)
SENTINEL_SCRIPTS_DIR=
# Set this only if the agent logs an IP that ipconfig disagrees with.
SENTINEL_HOST_IP=
"@

if (-not (Test-Path -LiteralPath $AgentDir)) {
  Write-Host "  $AgentDir does not exist - is this script inside the it-sentinel repo?" -ForegroundColor Red
  exit 1
}

$writeEnv = $true
if (Test-Path -LiteralPath $EnvPath) {
  $current = [IO.File]::ReadAllText($EnvPath)
  # Compare on the config lines only; the header carries a timestamp and
  # would make a re-run look like a change every time.
  $strip = { param($t) (($t -split "`r?`n") | Where-Object { $_ -and ($_ -notmatch '^\s*#') }) -join "`n" }
  if ((& $strip $current) -eq (& $strip $envBody)) {
    Write-Skip '.env already has exactly this configuration.'
    $writeEnv = $false
  } else {
    Copy-Item -LiteralPath $EnvPath -Destination ($EnvPath + '.bak') -Force
    Write-Info "Existing .env backed up to $EnvPath.bak"
  }
}
if ($writeEnv) {
  # UTF-8 without BOM: a BOM ends up inside the first key name when the
  # agent's dotenv parser reads the file.
  [IO.File]::WriteAllText($EnvPath, $envBody, (New-Object System.Text.UTF8Encoding($false)))
  Write-Ok "Wrote $EnvPath"
}

Write-Head 'DEPENDENCIES'
$nodeModules = Join-Path $RepoRoot 'node_modules'
if (Test-Path -LiteralPath $nodeModules) {
  Write-Skip 'node_modules present; skipping pnpm install.'
} elseif (Test-CommandExists 'pnpm') {
  Write-Info 'Running pnpm install (this takes a few minutes) ...'
  Push-Location $RepoRoot
  try { $code = Invoke-Native -File 'pnpm' -Arguments @('install') } finally { Pop-Location }
  if (Test-Path -LiteralPath $nodeModules) {
    Write-Ok 'pnpm install completed.'
  } else {
    Write-Fail "pnpm install did not produce node_modules (exit $code)." `
      "Run 'pnpm install' in $RepoRoot by hand and read the error."
  }
} else {
  Write-Fail 'Cannot run pnpm install because pnpm is missing.' 'Fix pnpm above, then re-run.'
}

# ------------------------------------------- 6. start it, NOT a service ---

Write-Head 'STARTING THE AGENT (INTERACTIVELY, ON PURPOSE)'
Write-Host @'
    This does NOT install a Windows service, and that is deliberate.

    A Windows service runs in session 0. Any GUI app it launches - Notepad,
    Chrome, the Camera app - runs there too, invisible on your desktop. It
    appears in Task Manager and nobody in the room sees a window. Three of
    the demo features ("Open Notepad on Lagos", "Open Chrome on Lagos",
    "Open all cameras") would report success and show nothing.

    So the agent runs in your logged-in desktop session instead: a shortcut
    in your Startup folder starts it at logon, and it is started now.

    apps/agent-node/install-service.ps1 is still the production path. Use it
    when nothing needs to be visible on a screen. Do not use it here.
'@

$hostForAgent = $null
if (Test-CommandExists 'pwsh') { $hostForAgent = (Get-Command pwsh).Source }
if (-not $hostForAgent) { $hostForAgent = Get-HostExe }

$agentCommand  = "Set-Location -LiteralPath '$RepoRoot'; pnpm --filter @it-sentinel/agent-node start"
$agentArgs     = '-NoExit -NoProfile -ExecutionPolicy Bypass -Command "' + $agentCommand + '"'
$startupDir    = [Environment]::GetFolderPath('Startup')
$shortcutPath  = Join-Path $startupDir 'IT Sentinel Agent.lnk'

try {
  $shell = New-Object -ComObject WScript.Shell
  $lnk = $shell.CreateShortcut($shortcutPath)
  $lnk.TargetPath       = $hostForAgent
  $lnk.Arguments        = $agentArgs
  $lnk.WorkingDirectory = $RepoRoot
  $lnk.Description      = 'IT Sentinel agent - interactive session (NOT a service; session 0 hides launched apps).'
  $lnk.Save()
  Write-Ok "Logon shortcut written: $shortcutPath"
} catch {
  Write-Fail ('Could not create the Startup shortcut: ' + $_.Exception.Message) `
    ("Start the agent by hand each time: cd $RepoRoot ; pnpm --filter @it-sentinel/agent-node start")
}

# Idempotence: do not stack a second agent on a re-run. Two agents on one
# machine double every heartbeat and race each other for commands.
$running = $null
try {
  $running = Get-CimInstance Win32_Process -Filter "Name='node.exe'" -ErrorAction Stop |
    Where-Object { $_.CommandLine -and $_.CommandLine -match 'agent-node' } |
    Select-Object -First 1
} catch { }

if ($running) {
  Write-Skip ('An agent process is already running (PID ' + $running.ProcessId + '); not starting another.')
  Write-Warn 'It is still using the OLD .env. Close its window and re-launch it if the branch or URL changed.'
} else {
  Start-Process -FilePath $hostForAgent -ArgumentList $agentArgs -WorkingDirectory $RepoRoot | Out-Null
  Write-Ok 'Agent started in a new window. Leave that window open.'
  Write-Info "Watch it for: identified as asset <uuid> (<this machine's LAN IP>)"
}

# ----------------------------------------------------- 7. verification ---

Write-Head 'VERIFICATION'

$pwshVersion = $null
try {
  $prev = $ErrorActionPreference; $ErrorActionPreference = 'Continue'
  $pwshVersion = (& pwsh -v 2>&1 | Out-String).Trim()
  $ErrorActionPreference = $prev
} catch { }
if ($pwshVersion -and $pwshVersion -match 'PowerShell\s+7') {
  Write-Ok "pwsh works: $pwshVersion"
} else {
  Write-Fail 'pwsh -v did not report PowerShell 7.' `
    'The agent shells out to pwsh, not powershell. Install it: winget install -e --id Microsoft.PowerShell, then open a NEW terminal.'
}

if (Test-PortListening -ComputerName 'localhost' -Port 5900) {
  Write-Ok 'TightVNC is listening on localhost:5900.'
} else {
  Write-Fail 'Nothing is listening on port 5900.' `
    'Start-Service tvnserver ; if that fails, reinstall TightVNC and tick "Register as service".'
}

try {
  $health = Invoke-RestMethod -Uri ($ControlPlaneUrl + '/healthz') -TimeoutSec 10 -ErrorAction Stop
  if ($health -and $health.status -eq 'ok') {
    Write-Ok "$ControlPlaneUrl/healthz returned ok."
  } else {
    Write-Fail "$ControlPlaneUrl/healthz answered but not with status=ok." `
      'Check the control plane logs on the hub laptop.'
  }
} catch {
  Write-Fail ("Could not reach $ControlPlaneUrl/healthz - " + $_.Exception.Message) `
    'Is the hub running (pnpm --filter @it-sentinel/control-plane dev)? Is 8787 open on the hub firewall? If other machines reach it and this one cannot, suspect AP client isolation - see the runbook Troubleshooting table.'
}

$ip = Get-PrimaryIPv4
if ($ip) {
  Write-Host ''
  Write-Host "  This machine's primary LAN IPv4: $ip" -ForegroundColor White
  Write-Host '  Check it against `ipconfig`. If the agent logs a different address,' -ForegroundColor White
  Write-Host '  set SENTINEL_HOST_IP in apps/agent-node/.env - the relay dials that' -ForegroundColor White
  Write-Host '  address to reach TightVNC, and remote desktop fails if it is wrong.' -ForegroundColor White
} else {
  Write-Fail 'Could not determine a primary LAN IPv4 address.' `
    'Run ipconfig, find the Wi-Fi adapter IPv4, and set SENTINEL_HOST_IP in apps/agent-node/.env.'
}

# --------------------------------------------------------- 8. verdict ---

Write-Host ''
if ($Failures.Count -eq 0) {
  Write-Host ('  ' + ('-' * 70)) -ForegroundColor Green
  Write-Host ('  SETUP COMPLETE - ' + $chosen.Name + ' (' + $chosen.Slug + ') -> ' + $ControlPlaneUrl) -ForegroundColor Green
  Write-Host ('  ' + ('-' * 70)) -ForegroundColor Green
  Write-Host '  Still to do by hand:'
  Write-Host '    1. Confirm the TightVNC password matches the other 6 laptops.'
  Write-Host '    2. Confirm this machine appears on the dashboard within 15 seconds.'
  Write-Host '    3. Run scripts\preflight.ps1 before you go on stage.'
} else {
  Write-Host ('  ' + ('-' * 70)) -ForegroundColor Red
  Write-Host ('  SETUP INCOMPLETE - ' + $Failures.Count + ' check(s) failed. Do not assume this laptop is ready.') -ForegroundColor Red
  Write-Host ('  ' + ('-' * 70)) -ForegroundColor Red
  $n = 1
  foreach ($f in $Failures) {
    Write-Host ("  $n. " + $f) -ForegroundColor Red
    $n++
  }
  Write-Host ''
  Write-Host '  Fix the above, then run this script again - it is safe to re-run.' -ForegroundColor Yellow
}
Write-Host ''

if ($Relaunched) {
  # This is the self-elevated window; without a pause it vanishes with the
  # results in it.
  Read-Host '  Press Enter to close this window' | Out-Null
}

if ($Failures.Count -gt 0) { exit 1 }
exit 0
