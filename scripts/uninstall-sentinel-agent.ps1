<#
  IT Sentinel - take this laptop back out of the demo fleet.

  The reverse of scripts/install-sentinel-agent.ps1, and deliberately not a
  symmetric one. The installer added several things; only some of them are
  IT Sentinel's to take away.

    Removed  the agent process, the Startup shortcut, apps/agent-node/.env
             and the inbound firewall hole the demo opened.
    Asked    TightVNC. You may have had it before the demo, so this script
             will not guess. It defaults to leaving it alone.
    Kept     Node.js, PowerShell 7, Git and Chrome. They are general-purpose
             tools the machine probably needs, and uninstalling somebody's
             browser to tidy up after a hackathon is not acceptable.

  It shows exactly what it will do and refuses to move until you type
  UNINSTALL.

  Usage:
    .\uninstall-sentinel-agent.ps1
    .\uninstall-sentinel-agent.ps1 -VncAction uninstall
    .\uninstall-sentinel-agent.ps1 -RemoveRepo

  Safe to run twice. Every step checks first and succeeds quietly if the
  thing it removes is already gone.

  This script only cleans the machine. The asset row stays on the roster
  until an operator retires it server-side - see docs/18-decommissioning.md.
#>
[CmdletBinding()]
param(
  # What to do about TightVNC. Prompted for if omitted, and the prompt
  # defaults to 'leave'.
  #   leave     - touch nothing (default)
  #   stop      - stop the service and set it to Manual start
  #   uninstall - winget uninstall TightVNC entirely
  [ValidateSet('leave', 'stop', 'uninstall')]
  [string]$VncAction,

  # Delete the cloned repo, including node_modules and any uncommitted work.
  # Off by default: it is the owner's disk and the owner's call.
  [switch]$RemoveRepo,

  # --- internal: set by the self-elevation relaunch, do not pass by hand ---
  [switch]$ConsentAccepted,
  [switch]$Relaunched,
  [string]$InvokingUser
)

# Stop on the first unhandled error rather than limping onward and printing a
# clean bill of health over a half-finished removal. The removal work itself
# is wrapped in try/catch/finally so that an error still ends with an honest
# account of what did and did not come off.
$ErrorActionPreference = 'Stop'

$RepoRoot = Split-Path -Parent $PSScriptRoot
$AgentDir = Join-Path $RepoRoot 'apps\agent-node'
$EnvPath  = Join-Path $AgentDir '.env'

# The exact DisplayName install-sentinel-agent.ps1 creates the rule with, and
# the one preflight.ps1 looks for. Changing it in one place and not the other
# two leaves the firewall hole open on every laptop, so keep the three in step.
$VncRule  = 'IT Sentinel - TightVNC (TCP 5900)'

$Failures = New-Object System.Collections.Generic.List[string]
$Removed  = New-Object System.Collections.Generic.List[string]
$Left     = New-Object System.Collections.Generic.List[string]

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
function Add-Removed($text) { $Removed.Add($text) | Out-Null }
function Add-Left($text)    { $Left.Add($text)    | Out-Null }

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

# The installer starts the agent as a pwsh window running
# `pnpm --filter @it-sentinel/agent-node start`, which in turn runs node.exe.
# Killing only node.exe leaves an empty console window behind, so match on the
# command line instead of the image name and take both. This script is called
# uninstall-sentinel-agent.ps1, which does not contain 'agent-node', so it
# cannot match itself - but $PID is excluded anyway rather than relying on it.
function Get-AgentProcesses {
  $found = New-Object System.Collections.Generic.List[object]
  try {
    $procs = Get-CimInstance Win32_Process -ErrorAction Stop |
      Where-Object {
        $_.CommandLine -and
        $_.CommandLine -match 'agent-node' -and
        $_.ProcessId -ne $PID
      }
    foreach ($p in $procs) { $found.Add($p) | Out-Null }
  } catch {
    Write-Warn ('Could not enumerate processes: ' + $_.Exception.Message)
  }
  return $found
}

function Test-PortListening {
  param([string]$ComputerName, [int]$Port)
  try {
    return [bool](Test-NetConnection -ComputerName $ComputerName -Port $Port `
      -InformationLevel Quiet -WarningAction SilentlyContinue -ErrorAction Stop)
  } catch { return $false }
}

# Under UAC the Startup folder resolves to whichever profile the elevated
# session belongs to, which is not necessarily the profile the shortcut was
# written into. Collect both candidates and remove the shortcut from either.
function Get-StartupShortcutPaths {
  $paths = New-Object System.Collections.Generic.List[string]
  $mine = Join-Path ([Environment]::GetFolderPath('Startup')) 'IT Sentinel Agent.lnk'
  $paths.Add($mine) | Out-Null
  if ($InvokingUser -and ($InvokingUser -ne $env:USERNAME)) {
    $other = Join-Path ($env:SystemDrive + '\Users\' + $InvokingUser) `
      'AppData\Roaming\Microsoft\Windows\Start Menu\Programs\Startup\IT Sentinel Agent.lnk'
    $paths.Add($other) | Out-Null
  }
  return $paths
}

# ------------------------------------------------- 1. explain, then ask ---

$vncExe     = Get-TightVncExe
$vncService = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue

Write-Host ''
Write-Host '  IT SENTINEL - remove the agent from this laptop' -ForegroundColor White
Write-Host '  -----------------------------------------------' -ForegroundColor White
Write-Host "  Machine : $env:COMPUTERNAME"
Write-Host "  User    : $env:USERDOMAIN\$env:USERNAME"
Write-Host "  Repo    : $RepoRoot"

Write-Head 'WHAT THIS SCRIPT WILL REMOVE'
Write-Host @"
    Process  : any running IT Sentinel agent, and the console window the
               logon shortcut opened for it.
    Startup  : the 'IT Sentinel Agent.lnk' shortcut, so nothing restarts at
               the next logon.
    Files    : $EnvPath
               (the control-plane URL and branch this machine reported to)
    Firewall : the inbound allow rule '$VncRule'
               - inbound TCP 5900 is closed again on all three profiles.

    After this the machine stops sending heartbeats, stops polling for
    commands, and stops accepting remote-desktop connections through the
    rule this demo opened.
"@

Write-Head 'WHAT IT WILL NOT TOUCH'
Write-Host @"
    Node.js, PowerShell 7, Git, Google Chrome, pnpm.
      These are general-purpose tools. The installer may have put them here,
      but plenty of other things on this machine now depend on them, and
      uninstalling somebody's browser to tidy up after a demo is not this
      script's business. Remove them yourself if you want them gone:
        winget uninstall -e --id OpenJS.NodeJS.LTS
        winget uninstall -e --id Microsoft.PowerShell
        winget uninstall -e --id Git.Git
        winget uninstall -e --id Google.Chrome

    TightVNC.
      Asked about below, and left alone unless you say otherwise. You may
      have been using it before the demo.

    The repo at $RepoRoot
      Left in place, node_modules and all. Delete it yourself, or re-run
      this script with -RemoveRepo.

    Anything the control plane already recorded.
      Every command that ran on this machine and every remote session opened
      against it stays in the audit trail. That is the point of the audit
      trail: uninstalling the agent is not a way to erase what was done.
"@

Write-Head 'WHAT THIS SCRIPT CANNOT DO FROM HERE'
Write-Host @'
    It cannot take this machine off the roster. That is a server-side action
    an operator performs against the control plane, and it is deliberately
    not something a laptop can do to itself. Until somebody retires the
    asset, the dashboard keeps a row for this machine.

    See docs/18-decommissioning.md. The short version is at the end of this
    script.
'@

if ($RemoveRepo) {
  Write-Host ''
  Write-Host '  -RemoveRepo was passed. This will DELETE the whole folder:' -ForegroundColor Yellow
  Write-Host ('    ' + $RepoRoot) -ForegroundColor Yellow
  Write-Host '  including node_modules, any .env files, and any uncommitted work in it.' -ForegroundColor Yellow
}

if ($ConsentAccepted) {
  Write-Host ''
  Write-Host '  Consent was given in the window that launched this one.' -ForegroundColor DarkGray
} else {
  Write-Host ''
  Write-Host '  Type UNINSTALL (capitals) to proceed. Anything else aborts.' -ForegroundColor Yellow
  $answer = Read-Host '  >'
  if ($answer -cne 'UNINSTALL') {
    Write-Host ''
    Write-Host '  Aborted. Nothing was removed or changed.' -ForegroundColor Yellow
    exit 1
  }

  # ------------------------------------------------- 2. the TightVNC ask ---

  if (-not $VncAction) {
    if (-not $vncExe -and -not $vncService) {
      $VncAction = 'leave'
    } else {
      Write-Head 'TIGHTVNC - YOUR CHOICE'
      Write-Host @'
    TightVNC is on this machine. The demo needed it, but it is ordinary
    remote-desktop software and you may well have had it before the demo.
    This script will not guess, and it will not uninstall it silently.

      1) LEAVE it exactly as it is                          [default]
      2) STOP the service and set it to Manual start
         - nothing listens on 5900 until you start it again
      3) UNINSTALL TightVNC entirely (winget uninstall)

    If the installer put TightVNC here and you have no other use for it,
    3 is the clean answer. If you are not sure, 1 and 2 are both reversible.
'@
      Write-Host ''
      $pick = Read-Host '  Number (1-3) [1]'
      if ([string]::IsNullOrWhiteSpace($pick)) { $pick = '1' }
      if ($pick -eq '2') {
        $VncAction = 'stop'
      } elseif ($pick -eq '3') {
        $VncAction = 'uninstall'
      } else {
        $VncAction = 'leave'
      }
      Write-Ok ('TightVNC: ' + $VncAction)
    }
  }

  # A whole directory tree, possibly with work in it, gets its own answer.
  if ($RemoveRepo) {
    Write-Host ''
    Write-Host '  Type REMOVE REPO (capitals) to confirm deleting the folder above.' -ForegroundColor Yellow
    Write-Host '  Anything else leaves it in place; every other step still runs.' -ForegroundColor Yellow
    $repoAnswer = Read-Host '  >'
    if ($repoAnswer -cne 'REMOVE REPO') {
      $RemoveRepo = $false
      Write-Warn 'Not deleting the repo. Continuing with everything else.'
    }
  }
}

if (-not $VncAction) { $VncAction = 'leave' }

# ------------------------------------------------------- 3. elevation ---

if (-not (Test-Elevated)) {
  Write-Head 'ADMINISTRATOR RIGHTS NEEDED'
  Write-Host @'
    This session is not elevated. The machine-wide parts of the removal
    cannot work without it:
      - deleting the inbound firewall rule for port 5900 is a machine-wide
        change
      - TightVNC Server is a Windows service; stopping, reconfiguring or
        uninstalling a service requires administrator
      - the agent process may belong to another session and need force

    Windows will now show a UAC prompt. Approve it and this script continues
    in a new elevated window; the work happens there.
'@

  # Built as ONE string rather than an array: Start-Process joins an array
  # with spaces and does not add quoting, so a repo path containing a space
  # would silently split into two arguments.
  $relaunch = '-NoProfile -ExecutionPolicy Bypass -File "{0}" -ConsentAccepted -Relaunched -InvokingUser "{1}" -VncAction {2}' `
                -f $PSCommandPath, $env:USERNAME, $VncAction
  if ($RemoveRepo) { $relaunch += ' -RemoveRepo' }

  try {
    $p = Start-Process -FilePath (Get-HostExe) -ArgumentList $relaunch -Verb RunAs -PassThru -Wait
    exit $p.ExitCode
  } catch {
    Write-Host ''
    Write-Host '  UAC was declined (or elevation failed), so nothing has been removed.' -ForegroundColor Red
    Write-Host '  Nothing on this machine was changed. To continue you need either:' -ForegroundColor Red
    Write-Host '    - to run this again and click Yes on the UAC prompt, or' -ForegroundColor Red
    Write-Host '    - an account with local administrator rights on this laptop.' -ForegroundColor Red
    Write-Host ''
    Write-Host '  If you cannot get administrator here, these are the two steps that' -ForegroundColor Red
    Write-Host '  matter most, for whoever can:' -ForegroundColor Red
    Write-Host ("    Remove-NetFirewallRule -DisplayName '" + $VncRule + "'") -ForegroundColor Red
    Write-Host '    Stop-Service tvnserver ; Set-Service tvnserver -StartupType Manual' -ForegroundColor Red
    Write-Host ('  (' + $_.Exception.Message + ')') -ForegroundColor DarkGray
    exit 1
  }
}

Write-Head 'ELEVATION'
Write-Ok "Running elevated as $env:USERDOMAIN\$env:USERNAME."

if ($InvokingUser -and ($InvokingUser -ne $env:USERNAME)) {
  Write-Warn "Elevated as '$env:USERNAME' but launched by '$InvokingUser'."
  Write-Warn "Both profiles' Startup folders will be checked for the shortcut."
}

# =========================================================================
# Everything below changes the machine. The finally block always prints the
# verification table and the checklist, so an error part way through still
# ends with an honest account of what came off and what did not.
# =========================================================================

$repoRemoved = $false

try {

  # ------------------------------------------------- 4. the agent process ---

  Write-Head 'AGENT PROCESS'

  $agents = Get-AgentProcesses
  if ($agents.Count -eq 0) {
    Write-Skip 'No IT Sentinel agent process is running.'
    Add-Left 'agent process (was not running)'
  } else {
    foreach ($a in $agents) {
      Write-Info ('Stopping ' + $a.Name + ' PID ' + $a.ProcessId + ' ...')
      try {
        Stop-Process -Id $a.ProcessId -Force -ErrorAction Stop
      } catch {
        # A child that its parent already took down is not a failure; the
        # re-probe below is what decides.
        Write-Skip ('PID ' + $a.ProcessId + ' was already gone (' + $_.Exception.Message + ')')
      }
    }

    # Killing the pwsh host may or may not take node.exe with it, depending
    # on how pnpm spawned it. Re-probe rather than assume.
    $tries = 0
    $stillUp = Get-AgentProcesses
    while ($stillUp.Count -gt 0 -and $tries -lt 3) {
      Start-Sleep -Milliseconds 700
      foreach ($a in $stillUp) {
        try { Stop-Process -Id $a.ProcessId -Force -ErrorAction Stop } catch { }
      }
      $tries = $tries + 1
      $stillUp = Get-AgentProcesses
    }

    if ($stillUp.Count -eq 0) {
      Write-Ok 'Agent stopped. No process matching agent-node is left.'
      Add-Removed 'the running agent process'
    } else {
      $pidList = ($stillUp | ForEach-Object { $_.ProcessId }) -join ', '
      Write-Fail ('An agent process is still running (PID ' + $pidList + ').') `
        ('Close its console window, or run: Stop-Process -Id ' + $pidList + ' -Force')
    }
  }

  # ------------------------------------------------ 5. the logon shortcut ---

  Write-Head 'LOGON SHORTCUT'

  $shortcutHit = $false
  foreach ($sc in (Get-StartupShortcutPaths)) {
    if (Test-Path -LiteralPath $sc) {
      try {
        Remove-Item -LiteralPath $sc -Force -ErrorAction Stop
        Write-Ok ('Removed ' + $sc)
        Add-Removed 'the Startup shortcut (the agent no longer starts at logon)'
        $shortcutHit = $true
      } catch {
        Write-Fail ('Could not remove ' + $sc + ': ' + $_.Exception.Message) `
          'Delete it by hand: run  explorer shell:startup  and delete "IT Sentinel Agent.lnk".'
      }
    }
  }
  if (-not $shortcutHit) {
    Write-Skip 'No IT Sentinel Agent shortcut in the Startup folder(s) checked.'
    Add-Left 'Startup shortcut (was not there)'
    Write-Info 'If the agent still comes back at logon, look in: explorer shell:startup'
  }

  # ------------------------------------------------------ 6. agent config ---

  Write-Head 'AGENT CONFIG'

  if (Test-Path -LiteralPath $EnvPath) {
    try {
      Remove-Item -LiteralPath $EnvPath -Force -ErrorAction Stop
      Write-Ok ('Deleted ' + $EnvPath)
      Add-Removed 'apps/agent-node/.env (control-plane URL and branch)'
    } catch {
      Write-Fail ('Could not delete ' + $EnvPath + ': ' + $_.Exception.Message) `
        ('Delete it by hand: Remove-Item -LiteralPath "' + $EnvPath + '" -Force')
    }
  } else {
    Write-Skip '.env is already gone.'
    Add-Left '.env (was not there)'
  }

  # The installer writes .env.bak when it overwrites an existing .env, so the
  # backup may hold configuration that predates the demo. Not ours to delete.
  $envBak = $EnvPath + '.bak'
  if (Test-Path -LiteralPath $envBak) {
    Write-Info ('Left ' + $envBak + " - the installer's backup of whatever .env was there before.")
    Add-Left ($envBak + ' (pre-demo backup; delete it yourself if you want it gone)')
  }

  # ---------------------------------------------------- 7. firewall rule ---

  Write-Head 'FIREWALL'

  $rules = @(Get-NetFirewallRule -DisplayName $VncRule -ErrorAction SilentlyContinue)
  if ($rules.Count -eq 0) {
    Write-Skip ("No rule named '" + $VncRule + "' - already removed, or never created.")
    Add-Left 'firewall rule (was not there)'
  } else {
    try {
      # By DisplayName, so a machine that somehow ended up with two copies is
      # cleared in one go.
      Remove-NetFirewallRule -DisplayName $VncRule -ErrorAction Stop
      Write-Ok ("Removed firewall rule '" + $VncRule + "' (" + $rules.Count + ' rule object(s)).')
      Add-Removed 'the inbound TCP 5900 firewall rule'
    } catch {
      Write-Fail ('Could not remove the firewall rule: ' + $_.Exception.Message) `
        ('Remove it by hand, elevated: Remove-NetFirewallRule -DisplayName "' + $VncRule + '"')
    }
  }

  # Other rules may still be opening 5900 - TightVNC's own installer adds one
  # if you let it - and this script has no business deleting a rule it did not
  # create. Say so rather than implying the port is now shut.
  # Two cmdlet calls, joined on InstanceID. Piping each rule into
  # Get-NetFirewallPortFilter instead takes the better part of a minute on a
  # machine with a few hundred rules, which is most of them.
  $otherOpen = @()
  try {
    $openIds = @(Get-NetFirewallPortFilter -ErrorAction SilentlyContinue |
      Where-Object { $_.LocalPort -contains '5900' } |
      ForEach-Object { $_.InstanceID })
    if ($openIds.Count -gt 0) {
      $otherOpen = @(Get-NetFirewallRule -Direction Inbound -Enabled True -Action Allow -ErrorAction SilentlyContinue |
        Where-Object { $_.DisplayName -ne $VncRule -and $openIds -contains $_.Name })
    }
  } catch {
    Write-Warn ('Could not check for other rules allowing 5900: ' + $_.Exception.Message)
  }
  if ($otherOpen.Count -gt 0) {
    Write-Warn ('Another ' + $otherOpen.Count + ' inbound rule(s) still allow TCP 5900:')
    foreach ($r in $otherOpen) { Write-Warn ('  - ' + $r.DisplayName) }
    Write-Warn 'IT Sentinel did not create these, so they are left alone. Review them yourself.'
    Add-Left ('other inbound rules allowing 5900 (' + $otherOpen.Count + ') - not created by IT Sentinel')
  }

  # -------------------------------------------------------- 8. tightvnc ---

  Write-Head 'TIGHTVNC'

  if (-not $vncExe -and -not $vncService) {
    Write-Skip 'TightVNC is not installed on this machine.'
    Add-Left 'TightVNC (not installed)'
  } elseif ($VncAction -eq 'leave') {
    Write-Skip 'Leaving TightVNC exactly as it is (your choice, and the default).'
    if ($vncService) {
      Write-Info ('tvnserver is ' + $vncService.Status + ', start type ' + $vncService.StartType + '.')
    }
    Write-Warn 'It still listens on 5900 for anything a remaining firewall rule allows through.'
    Add-Left 'TightVNC, installed and untouched (you chose to keep it)'
  } else {
    $svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
    if ($svc) {
      if ($svc.Status -eq 'Running') {
        try {
          Stop-Service -Name 'tvnserver' -Force -ErrorAction Stop
          Write-Ok 'TightVNC service stopped.'
        } catch {
          Write-Fail ('Could not stop tvnserver: ' + $_.Exception.Message) `
            'Stop it in services.msc, or run: Stop-Service tvnserver -Force'
        }
      } else {
        Write-Skip ('TightVNC service was already ' + $svc.Status + '.')
      }
      try {
        Set-Service -Name 'tvnserver' -StartupType Manual -ErrorAction Stop
        Write-Ok 'TightVNC service set to Manual start (it will not come back at boot).'
        Add-Removed 'TightVNC service stopped and set to Manual start'
      } catch {
        Write-Fail ('Could not set tvnserver to manual start: ' + $_.Exception.Message) `
          'Set it in services.msc, or it starts again at the next boot.'
      }
    } else {
      Write-Skip 'No tvnserver service to stop.'
    }

    if ($VncAction -eq 'uninstall') {
      if (Test-CommandExists 'winget') {
        Write-Info 'Uninstalling TightVNC (winget uninstall -e --id GlavSoft.TightVNC) ...'
        $code = Invoke-Native -File 'winget' -Arguments @(
          'uninstall', '-e', '--id', 'GlavSoft.TightVNC', '--silent',
          '--accept-source-agreements')
        # winget exits 0 in cases where nothing was actually removed, so the
        # machine is probed and its exit code only reported - same idiom as
        # the installer.
        if (Get-TightVncExe) {
          Write-Fail ('TightVNC is still present after the uninstall (winget exit ' + $code + ').') `
            'Remove it from Settings > Apps > Installed apps, or run the TightVNC installer and choose Remove.'
        } else {
          Write-Ok 'TightVNC uninstalled and verified gone.'
          Add-Removed 'TightVNC (uninstalled at your request)'
        }
      } else {
        Write-Fail 'winget is not available, so TightVNC cannot be uninstalled here.' `
          'Remove it from Settings > Apps > Installed apps.'
      }
    } else {
      Write-Info 'TightVNC is still installed, just stopped. Uninstall it yourself if you want it gone:'
      Write-Info '  winget uninstall -e --id GlavSoft.TightVNC'
      Add-Left 'TightVNC installed but stopped and set to Manual start'
    }
  }

  # ------------------------------------------------------------ 9. repo ---

  Write-Head 'REPO'

  $nodeModules = Join-Path $RepoRoot 'node_modules'

  if (-not $RemoveRepo) {
    Write-Skip 'Leaving the repo in place. Your disk, your call.'
    Write-Info ('Repo         : ' + $RepoRoot)
    if (Test-Path -LiteralPath $nodeModules) {
      Write-Info ('node_modules : ' + $nodeModules + ' (installed by the installer; safe to delete)')
    }
    Write-Info 'Delete it whenever you like, or re-run this script with -RemoveRepo.'
    Add-Left ('the repo at ' + $RepoRoot)
  } else {
    # This script lives inside the folder it is about to delete. PowerShell
    # reads a .ps1 into memory rather than holding it open, so this works -
    # but the working directory must not be inside the tree, or the delete
    # fails with a sharing violation on the directory itself.
    Set-Location -LiteralPath ($env:SystemDrive + '\')
    try {
      Remove-Item -LiteralPath $RepoRoot -Recurse -Force -ErrorAction Stop
      Write-Ok ('Deleted ' + $RepoRoot)
      Add-Removed ('the repo at ' + $RepoRoot)
      $repoRemoved = $true
    } catch {
      Write-Fail ('Could not delete the repo: ' + $_.Exception.Message) `
        ('Close any editor or terminal open inside it, then: Remove-Item -LiteralPath "' + $RepoRoot + '" -Recurse -Force')
    }
  }

} catch {
  Write-Host ''
  Write-Host ('  [FAIL] Unhandled error: ' + $_.Exception.Message) -ForegroundColor Red
  $Failures.Add('Unhandled error: ' + $_.Exception.Message +
    "`n         fix: read the table below to see what did come off, then re-run this script - it is safe to re-run.") | Out-Null
} finally {

  # -------------------------------------------------- 10. verification ---
  #
  # Re-probe the machine rather than trusting the steps above. This is the
  # mirror image of preflight.ps1: there, PASS means the agent is ready to
  # run. Here, GONE means it cannot.

  Write-Head 'VERIFICATION'

  $checks = New-Object System.Collections.Generic.List[object]

  $stillRunning = Get-AgentProcesses
  if ($stillRunning.Count -eq 0) {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'agent process'; Detail = 'no process matching agent-node' }) | Out-Null
  } else {
    $checks.Add([PSCustomObject]@{ Status = 'STILL'; Check = 'agent process'
      Detail = (($stillRunning | ForEach-Object { $_.Name + ' PID ' + $_.ProcessId }) -join ', ') }) | Out-Null
  }

  $scLeft = @(Get-StartupShortcutPaths | Where-Object { Test-Path -LiteralPath $_ })
  if ($scLeft.Count -eq 0) {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'logon shortcut'; Detail = 'no IT Sentinel Agent.lnk in Startup' }) | Out-Null
  } else {
    $checks.Add([PSCustomObject]@{ Status = 'STILL'; Check = 'logon shortcut'; Detail = ($scLeft -join ', ') }) | Out-Null
  }

  if ($repoRemoved) {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'agent .env'; Detail = 'the whole repo was deleted' }) | Out-Null
  } elseif (Test-Path -LiteralPath $EnvPath) {
    $checks.Add([PSCustomObject]@{ Status = 'STILL'; Check = 'agent .env'; Detail = $EnvPath }) | Out-Null
  } else {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'agent .env'; Detail = 'apps/agent-node/.env does not exist' }) | Out-Null
  }

  $ruleLeft = @(Get-NetFirewallRule -DisplayName $VncRule -ErrorAction SilentlyContinue)
  if ($ruleLeft.Count -eq 0) {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'firewall rule 5900'; Detail = $VncRule }) | Out-Null
  } else {
    $checks.Add([PSCustomObject]@{ Status = 'STILL'; Check = 'firewall rule 5900'; Detail = 'the rule is still present' }) | Out-Null
  }

  if (Test-PortListening -ComputerName 'localhost' -Port 5900) {
    $checks.Add([PSCustomObject]@{ Status = 'LEFT'; Check = 'port 5900 locally'
      Detail = 'TightVNC is still listening; reachable only if some rule allows it' }) | Out-Null
  } else {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'port 5900 locally'; Detail = 'nothing is listening on 5900' }) | Out-Null
  }

  $svcNow = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
  if (-not $svcNow) {
    $checks.Add([PSCustomObject]@{ Status = 'GONE'; Check = 'tvnserver service'; Detail = 'not installed' }) | Out-Null
  } else {
    $checks.Add([PSCustomObject]@{ Status = 'LEFT'; Check = 'tvnserver service'
      Detail = ($svcNow.Status.ToString() + ', start type ' + $svcNow.StartType.ToString()) }) | Out-Null
  }

  foreach ($t in @(
      @{ Name = 'node'; Label = 'Node.js' },
      @{ Name = 'pwsh'; Label = 'PowerShell 7' },
      @{ Name = 'git';  Label = 'Git' })) {
    if (Test-CommandExists $t.Name) {
      $checks.Add([PSCustomObject]@{ Status = 'KEPT'; Check = ($t.Label + ' on PATH'); Detail = 'deliberately not removed' }) | Out-Null
    }
  }

  $width = 0
  foreach ($c in $checks) { if ($c.Check.Length -gt $width) { $width = $c.Check.Length } }

  Write-Host ''
  foreach ($c in $checks) {
    $color = 'Gray'
    if ($c.Status -eq 'GONE')  { $color = 'Green' }
    if ($c.Status -eq 'STILL') { $color = 'Red' }
    if ($c.Status -eq 'LEFT')  { $color = 'Yellow' }
    if ($c.Status -eq 'KEPT')  { $color = 'Cyan' }
    Write-Host ('  {0,-5}  {1}  {2}' -f $c.Status, $c.Check.PadRight($width), $c.Detail) -ForegroundColor $color
  }
  Write-Host ''
  Write-Host '  GONE = removed.  LEFT = still here on purpose.  KEPT = deliberately not touched.' -ForegroundColor DarkGray
  Write-Host '  STILL = it should have gone and did not; read the failures below.' -ForegroundColor DarkGray

  # -------------------------------------------------- 11. the checklist ---

  Write-Head 'REMOVED'
  if ($Removed.Count -eq 0) {
    Write-Host '    Nothing - this machine was already clean.'
  } else {
    foreach ($r in $Removed) { Write-Host ('    - ' + $r) }
  }

  Write-Head 'DELIBERATELY LEFT ON THIS MACHINE'
  Write-Host '    - Node.js, PowerShell 7, Git, Chrome, pnpm (general-purpose tools)'
  foreach ($l in $Left) { Write-Host ('    - ' + $l) }

  Write-Head 'STILL TO DO - SERVER SIDE, BY AN OPERATOR'
  Write-Host @'
    This machine is clean, but the fleet does not know that yet. The asset
    row is still on the roster and still owns its history. An operator with
    l3_sysadmin, security_admin or it_manager at that site has to retire it.

    Any one of these:

      Voice    "Retire <hostname> at <branch>", then "confirm retire".
               Two turns on purpose: speech recognition mishears hostnames,
               and a machine should not leave the board on a mishearing.

      Console  the retire control on that machine's row in the fleet table.

      SQL      select * from public.retire_asset(
                 '<asset uuid>', 'demo over, agent uninstalled', '<operator uuid>');

    Retiring is a soft delete, on purpose. It stamps decommissioned_at, ends
    any open session, burns unredeemed session tokens, writes an
    asset.decommissioned row to audit_log, and stops sweep_stale_assets()
    alerting on this machine forever. It does not DELETE the asset, because
    deleting it would cascade away every command ever run on it - and being
    able to erase that is exactly what the audit trail exists to prevent.

    restore_asset() puts it back if this turns out to have been a mistake.

    Full detail: docs/18-decommissioning.md
'@

  Write-Host ''
  if ($Failures.Count -eq 0) {
    Write-Host ('  ' + ('-' * 70)) -ForegroundColor Green
    Write-Host ('  AGENT REMOVED FROM ' + $env:COMPUTERNAME) -ForegroundColor Green
    Write-Host ('  ' + ('-' * 70)) -ForegroundColor Green
    Write-Host '  Nothing restarts at the next logon. Ask the operator to retire the'
    Write-Host '  asset, then confirm the machine is off the dashboard.'
  } else {
    Write-Host ('  ' + ('-' * 70)) -ForegroundColor Red
    Write-Host ('  REMOVAL INCOMPLETE - ' + $Failures.Count + ' step(s) failed. Do not assume this laptop is clean.') -ForegroundColor Red
    Write-Host ('  ' + ('-' * 70)) -ForegroundColor Red
    $n = 1
    foreach ($f in $Failures) {
      Write-Host ('  ' + $n + '. ' + $f) -ForegroundColor Red
      $n = $n + 1
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
}

if ($Failures.Count -gt 0) { exit 1 }
exit 0
