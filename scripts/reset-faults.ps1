<#
.SYNOPSIS
  Undoes everything scripts/simulate-fault.ps1 can break. The "get back to
  green before the judges arrive" button.

.DESCRIPTION
  Idempotent, and safe on a machine that was never broken. It works from the
  state file simulate-fault.ps1 writes BEFORE it acts, so a simulation that
  died halfway still gets cleaned up. On top of that it runs a conservative
  sweep that needs no state file at all:

    - Start the Spooler if it is stopped.
    - Start tvnserver if it is installed and stopped.
    - Clear PRINTER_ATTRIBUTE_WORK_OFFLINE on the simulation printer, drain
      its queue, then remove it.
    - Report - but do NOT touch - any other printer that is currently
      offline or holding jobs, because that may be a genuine fault on a real
      device and silently "fixing" it would hide it from the dashboard.
    - Restart the Spooler so the cleared attributes are actually loaded.

  Pass -AllPrinters to clear the offline flag and drain every local queue on
  this machine. That is the panic button. It will also clear a real fault,
  so read what it prints.

.PARAMETER AllPrinters
  Clear WORK_OFFLINE and drain EVERY local queue, not just the ones this kit
  touched. Use when the state file is gone and something is still red.

.PARAMETER KeepSimPrinter
  Leave the IT-Sentinel-Sim printer installed. Saves a few seconds between
  rehearsal runs.

.EXAMPLE
  .\scripts\reset-faults.ps1

.EXAMPLE
  .\scripts\reset-faults.ps1 -AllPrinters

.NOTES
  Pure ASCII on purpose - see the note in simulate-fault.ps1.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [switch]$AllPrinters,
  [switch]$KeepSimPrinter
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

$script:SimPrinterName = 'IT-Sentinel-Sim'
$script:StateDir = Join-Path $env:ProgramData 'ITSentinel'
$script:StatePath = Join-Path $script:StateDir 'fault-sim-state.json'
$script:PrinterKeyRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
$script:WorkOfflineBit = 0x400

$script:Actions = @()
$script:Problems = @()

function Write-Head {
  param([string]$Text)
  Write-Host ''
  Write-Host ('== ' + $Text) -ForegroundColor Cyan
}

function Add-Action {
  param([string]$Text)
  $script:Actions += $Text
  Write-Host ('   + ' + $Text) -ForegroundColor Green
}

function Add-Skip {
  param([string]$Text)
  Write-Host ('   . ' + $Text) -ForegroundColor DarkGray
}

function Add-Problem {
  param([string]$Text)
  $script:Problems += $Text
  Write-Host ('   ! ' + $Text) -ForegroundColor Yellow
}

function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Read-State {
  if (-not (Test-Path -LiteralPath $script:StatePath)) { return $null }
  try {
    $raw = Get-Content -LiteralPath $script:StatePath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { return $null }
    return ($raw | ConvertFrom-Json)
  } catch {
    Add-Problem ('Could not parse ' + $script:StatePath + ' - falling back to the sweep only.')
    return $null
  }
}

function Get-StateFault {
  param([psobject]$State, [string]$Name)
  if (-not $State) { return $null }
  if ($State.PSObject.Properties.Name -notcontains 'faults') { return $null }
  if (-not $State.faults) { return $null }
  if ($State.faults.PSObject.Properties.Name -notcontains $Name) { return $null }
  return $State.faults.$Name
}

function Test-StateProp {
  param([psobject]$Obj, [string]$Name)
  if (-not $Obj) { return $false }
  return ($Obj.PSObject.Properties.Name -contains $Name)
}

<#
  Every CIM read goes through here so -WhatIf never leaks into the
  CimCmdlets module auto-load, which otherwise floods the output with a
  dozen "What if: Set Alias" lines before anything useful is printed.
#>
function Get-PrinterSnapshot {
  $WhatIfPreference = $false
  try {
    return @(Get-CimInstance Win32_Printer -ErrorAction Stop | ForEach-Object {
      [pscustomobject]@{
        Name    = $_.Name
        Online  = ((-not $_.WorkOffline) -and ($_.PrinterStatus -ne 7))
        Offline = ([bool]$_.WorkOffline -or ($_.PrinterStatus -eq 7))
      }
    })
  } catch {
    return @()
  }
}

function Get-PrinterKeyPath {
  param([string]$Name)
  return (Join-Path $script:PrinterKeyRoot $Name)
}

function Clear-PrinterOffline {
  param([string]$Name, [int]$RestoreTo = -1)

  $key = Get-PrinterKeyPath -Name $Name
  if (-not (Test-Path -LiteralPath $key)) {
    Add-Skip ('No registry key for printer "' + $Name + '" - nothing to clear.')
    return
  }
  $prop = Get-ItemProperty -LiteralPath $key -Name 'Attributes' -ErrorAction SilentlyContinue
  if (-not $prop) {
    Add-Skip ('Printer "' + $Name + '" has no Attributes value - nothing to clear.')
    return
  }

  $current = [int]$prop.Attributes
  if ($RestoreTo -ge 0) {
    $wanted = $RestoreTo
  } else {
    $wanted = $current -band (-bnot $script:WorkOfflineBit)
  }

  if ($current -eq $wanted) {
    Add-Skip ('Printer "' + $Name + '" attributes already ' + $current + ' - not touched.')
    return
  }

  if ($PSCmdlet.ShouldProcess($Name, ('Set printer Attributes ' + $current + ' -> ' + $wanted))) {
    Set-ItemProperty -LiteralPath $key -Name 'Attributes' -Value $wanted -Type DWord
    Add-Action ('Cleared the offline flag on "' + $Name + '" (attributes ' + $current + ' -> ' + $wanted + ').')
  }
}

function Clear-PrinterJobs {
  param([string]$Name)

  $jobs = @(Get-PrintJob -PrinterName $Name -ErrorAction SilentlyContinue)
  if ($jobs.Count -eq 0) {
    Add-Skip ('Queue "' + $Name + '" is already empty.')
    return
  }
  if ($PSCmdlet.ShouldProcess($Name, ('Remove ' + $jobs.Count + ' queued print jobs'))) {
    foreach ($j in $jobs) {
      Remove-PrintJob -InputObject $j -ErrorAction SilentlyContinue
    }
    $noun = 'jobs'
    if ($jobs.Count -eq 1) { $noun = 'job' }
    Add-Action ('Removed ' + $jobs.Count + ' queued ' + $noun + ' from "' + $Name + '".')
  }
}

function Restore-ServiceRunning {
  param([string]$Name, [string]$Label)

  $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
  if (-not $svc) {
    Add-Skip ($Label + ' (' + $Name + ') is not installed on this machine.')
    return
  }
  if ($svc.Status -eq 'Running') {
    Add-Skip ($Label + ' is already running.')
    return
  }
  if ($PSCmdlet.ShouldProcess($Name, 'Start service')) {
    try {
      Start-Service -Name $Name -ErrorAction Stop
      Start-Sleep -Seconds 2
      Add-Action ($Label + ' started.')
    } catch {
      Add-Problem ('Could not start ' + $Label + ': ' + $_.Exception.Message)
    }
  }
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
Write-Host ''
Write-Host 'IT Sentinel fault reset' -ForegroundColor Cyan
Write-Host ('Machine: ' + $env:COMPUTERNAME)

$whatIf = $false
if ($WhatIfPreference) { $whatIf = $true }

if (-not $whatIf -and -not (Test-Elevated)) {
  Write-Host ''
  Write-Host '   X This needs to run elevated.' -ForegroundColor Red
  Write-Host ''
  Write-Host '   Starting services and writing the printer registry keys both require'
  Write-Host '   Administrator. -WhatIf does not, which is why you got this far.'
  Write-Host ''
  Write-Host '   Open an Administrator PowerShell and run:'
  Write-Host ''
  Write-Host ('     cd "' + (Split-Path -Parent $PSScriptRoot) + '"')
  Write-Host '     .\scripts\reset-faults.ps1'
  Write-Host ''
  exit 1
}

$state = Read-State
$simPortWasCreated = $false

try {
  # -- 1. Services ----------------------------------------------------------
  # Unconditional. The Spooler must be up before any printer work, and a
  # stopped Spooler is a fault whether or not this kit caused it.
  Write-Head 'Services'
  Restore-ServiceRunning -Name 'Spooler'   -Label 'Print Spooler'
  Restore-ServiceRunning -Name 'tvnserver' -Label 'TightVNC Server'

  # -- 2. Whatever the state file recorded ----------------------------------
  Write-Head 'Printers named in the state file'

  $offlineState = Get-StateFault -State $state -Name 'printer-offline'
  if ($offlineState) {
    $restoreTo = -1
    if (Test-StateProp -Obj $offlineState -Name 'originalAttributes') {
      $restoreTo = [int]$offlineState.originalAttributes
    }
    Clear-PrinterOffline -Name $offlineState.printer -RestoreTo $restoreTo
    Clear-PrinterJobs -Name $offlineState.printer
    if ((Test-StateProp -Obj $offlineState -Name 'createdPort') -and $offlineState.createdPort) {
      $simPortWasCreated = $true
    }
  } else {
    Add-Skip 'No printer-offline entry recorded.'
  }

  $jobState = Get-StateFault -State $state -Name 'queued-jobs'
  if ($jobState -and (-not $offlineState -or $jobState.printer -ne $offlineState.printer)) {
    Clear-PrinterJobs -Name $jobState.printer
  }

  # -- 3. The simulation printer, state file or not -------------------------
  Write-Head 'Simulation printer'
  if (Get-Printer -Name $script:SimPrinterName -ErrorAction SilentlyContinue) {
    Clear-PrinterOffline -Name $script:SimPrinterName
    Clear-PrinterJobs -Name $script:SimPrinterName
    if ($KeepSimPrinter) {
      Add-Skip ('Left "' + $script:SimPrinterName + '" installed (-KeepSimPrinter).')
    } elseif ($PSCmdlet.ShouldProcess($script:SimPrinterName, 'Remove simulation printer')) {
      try {
        Remove-Printer -Name $script:SimPrinterName -ErrorAction Stop
        Add-Action ('Removed the simulation printer "' + $script:SimPrinterName + '".')
      } catch {
        Add-Problem ('Could not remove the simulation printer: ' + $_.Exception.Message)
      }
      if ($simPortWasCreated -and $PSCmdlet.ShouldProcess('nul:', 'Remove the printer port the simulation created')) {
        try {
          Remove-PrinterPort -Name 'nul:' -ErrorAction Stop
          Add-Action 'Removed the nul: printer port the simulation created.'
        } catch {
          Add-Skip 'Left the nul: printer port in place - something else is using it.'
        }
      }
    }
  } else {
    Add-Skip ('No simulation printer "' + $script:SimPrinterName + '" on this machine.')
  }

  # -- 4. Sweep every other local queue -------------------------------------
  Write-Head 'Other local queues'
  $others = @(Get-PrinterSnapshot | Where-Object { $_.Name -ne $script:SimPrinterName })

  if ($others.Count -eq 0) {
    Add-Skip 'No other printers on this machine.'
  }

  foreach ($p in $others) {
    $jobCount = @(Get-PrintJob -PrinterName $p.Name -ErrorAction SilentlyContinue).Count

    if (-not $p.Offline -and $jobCount -eq 0) {
      Add-Skip ('"' + $p.Name + '" is online with an empty queue - not touched.')
      continue
    }

    $desc = @()
    if ($p.Offline) { $desc += 'offline' }
    if ($jobCount -gt 0) { $desc += ([string]$jobCount + ' queued') }

    if ($AllPrinters) {
      Clear-PrinterOffline -Name $p.Name
      Clear-PrinterJobs -Name $p.Name
    } else {
      Add-Problem ('"' + $p.Name + '" is ' + ($desc -join ', ') + '. NOT touched - this may be a real fault. Use -AllPrinters to clear it anyway.')
    }
  }

  # -- 5. Reload the Spooler ------------------------------------------------
  # The Spooler caches printers in memory; clearing the registry flag without
  # this leaves the queue reporting offline until the next reboot.
  if ($script:Actions.Count -gt 0) {
    Write-Head 'Reloading the Spooler'
    if ($PSCmdlet.ShouldProcess('Spooler', 'Restart so printer attribute changes load')) {
      try {
        Restart-Service -Name Spooler -Force -ErrorAction Stop
        Start-Sleep -Seconds 3
        Add-Action 'Spooler restarted so the cleared attributes are loaded.'
      } catch {
        Add-Problem ('Could not restart the Spooler: ' + $_.Exception.Message)
      }
    }
  }

  # -- 6. Clear the state file ----------------------------------------------
  if (Test-Path -LiteralPath $script:StatePath) {
    if ($PSCmdlet.ShouldProcess($script:StatePath, 'Delete fault state file')) {
      Remove-Item -LiteralPath $script:StatePath -Force -ErrorAction SilentlyContinue
      Add-Action 'Cleared the fault state file.'
    }
  }
} catch {
  Write-Host ''
  Write-Host ('   X Reset hit an error: ' + $_.Exception.Message) -ForegroundColor Red
  Write-Host '   The summary below shows where the machine actually ended up.' -ForegroundColor Yellow
  $script:Problems += ('Reset errored: ' + $_.Exception.Message)
} finally {
  # Whatever happened above, never leave the Spooler down. A machine that
  # cannot enumerate printers looks broken on the dashboard and no playbook
  # in the library can repair it from there.
  $spooler = Get-Service -Name 'Spooler' -ErrorAction SilentlyContinue
  if ($spooler -and $spooler.Status -ne 'Running' -and -not $whatIf) {
    try {
      Start-Service -Name 'Spooler' -ErrorAction Stop
      Write-Host '   + Spooler was still down at exit and has been started.' -ForegroundColor Green
    } catch {
      Write-Host '   X Spooler is DOWN and could not be started. Fix this before you present.' -ForegroundColor Red
    }
  }
}

# ---------------------------------------------------------------------------
# Where the machine ended up. Mirrors collect.ps1 + toHeartbeat() +
# deriveHealthStatus() so you can see what the next heartbeat will say.
# ---------------------------------------------------------------------------
Write-Head 'Where this machine now stands'

$printers = Get-PrinterSnapshot
if ($printers.Count -eq 0) {
  $printerWire = 'unknown'
} elseif (@($printers | Where-Object { -not $_.Online }).Count -gt 0) {
  $printerWire = 'critical'
} else {
  $printerWire = 'healthy'
}

$securityWire = 'critical'
try {
  $mp = Get-MpComputerStatus -ErrorAction Stop
  if ($mp -and $mp.RealTimeProtectionEnabled) { $securityWire = 'healthy' }
} catch {
  $securityWire = 'critical'
}

$subs = @($printerWire, 'unknown', $securityWire, 'unknown')
if ($subs -contains 'critical') {
  $derived = 'critical'
} elseif ($subs -contains 'warning') {
  $derived = 'warning'
} else {
  $derived = 'healthy'
}

$vncSvc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
$vncWire = 'not installed'
if ($vncSvc) {
  if ($vncSvc.Status -eq 'Running') { $vncWire = 'running' } else { $vncWire = 'STOPPED' }
}
$spoolerSvc = Get-Service -Name 'Spooler' -ErrorAction SilentlyContinue
$spoolerWire = 'missing'
if ($spoolerSvc) { $spoolerWire = $spoolerSvc.Status.ToString() }

Write-Host ('   hb.printer           ' + $printerWire)
Write-Host ('   hb.endpointSecurity  ' + $securityWire)
Write-Host ('   hb.tightvnc          ' + $vncWire)
Write-Host ('   Spooler service      ' + $spoolerWire)
Write-Host ('   asset_health.status  ' + $derived.ToUpper())
Write-Host ''

if ($whatIf) {
  Write-Host 'WhatIf: nothing was changed.' -ForegroundColor Yellow
  Write-Host ''
  exit 0
}

$clean = ($derived -eq 'healthy' -and $printerWire -ne 'unknown' -and $vncWire -ne 'STOPPED' -and $script:Problems.Count -eq 0)
if ($clean) {
  Write-Host '   This machine is GREEN. It will report healthy on the next heartbeat.' -ForegroundColor Green
  Write-Host ''
  exit 0
}

Write-Host '   Read this before you present:' -ForegroundColor Yellow
foreach ($p in $script:Problems) {
  Write-Host ('     - ' + $p) -ForegroundColor Yellow
}
if ($printerWire -eq 'unknown') {
  Write-Host '     - hb.printer is "unknown": no printers enumerated. The Printer dot will be' -ForegroundColor Yellow
  Write-Host '       grey, not green. Check the Spooler, or install a printer.' -ForegroundColor Yellow
}
if ($printerWire -eq 'critical') {
  Write-Host '     - hb.printer is still "critical": a printer is offline. Re-run with' -ForegroundColor Yellow
  Write-Host '       -AllPrinters if the offline queue is not a real fault.' -ForegroundColor Yellow
}
if ($vncWire -eq 'STOPPED') {
  Write-Host '     - tvnserver is stopped, so remote desktop to this machine will fail.' -ForegroundColor Yellow
}
if ($securityWire -ne 'healthy') {
  Write-Host '     - Defender real-time protection is OFF. This kit never turns it off, so' -ForegroundColor Yellow
  Write-Host '       something else did. It raises a p1 alert and the announcer WILL speak it.' -ForegroundColor Yellow
}
Write-Host ''
exit 0
