<#
.SYNOPSIS
  Induces a REAL, reversible fault on this branch laptop so the IT Sentinel
  dashboard, the voice agent and the remediation playbooks have something
  genuine to react to.

.DESCRIPTION
  Every fault in this kit was traced from the thing it breaks, through
  apps/agent-node/src/collect.ps1, through toHeartbeat() in
  apps/agent-node/src/main.ts, into deriveHealthStatus()/evaluateChecks() in
  apps/control-plane/src/ingest/ingest.service.ts, and out to the console and
  voice surfaces. The trace is written above each fault below.

  Faults that produce no observable effect are deliberately NOT in this
  script. What this platform does not detect today is listed by -List and
  explained in docs/17-fault-simulation.md, and knowing it before you go on
  stage matters more than having a longer menu.

  Nothing here damages the machine, deletes data, or needs a reboot.
  Nothing here touches Microsoft Defender.

.PARAMETER Fault
  Which fault to induce. Run with -List to see them.

.PARAMETER List
  Print the fault table and exit. Side-effect free, works unelevated.

.PARAMETER Printer
  Target printer for the printer faults. Defaults to a simulation printer
  this script creates on the nul: port, so no physical device is ever
  involved. Point this at a real queue only if you want the room to see a
  real printer name.

.PARAMETER Jobs
  How many dummy jobs printer-down parks in the queue. Default 6.

.PARAMETER SkipVerify
  Skip the post-fault detection preview. Do not use this before a demo. The
  preview is the only thing that proves the fault will actually show up.

.EXAMPLE
  .\scripts\simulate-fault.ps1 -List

.EXAMPLE
  .\scripts\simulate-fault.ps1 -Fault printer-down

.EXAMPLE
  .\scripts\simulate-fault.ps1 -Fault spooler-stopped -WhatIf

.NOTES
  Pure ASCII on purpose. Windows PowerShell 5.1 reads a BOM-less .ps1 as
  ANSI, and a UTF-8 em dash becomes two bytes it treats as string
  delimiters. Keep it ASCII when you edit this.

  Undo everything with .\scripts\reset-faults.ps1.
#>

[CmdletBinding(SupportsShouldProcess = $true)]
param(
  [string]$Fault,
  [switch]$List,
  [string]$Printer,
  [int]$Jobs = 6,
  [switch]$SkipVerify
)

Set-StrictMode -Version 1.0
$ErrorActionPreference = 'Stop'

$script:SimPrinterName = 'IT-Sentinel-Sim'
$script:StateDir = Join-Path $env:ProgramData 'ITSentinel'
$script:StatePath = Join-Path $script:StateDir 'fault-sim-state.json'
$script:PrinterKeyRoot = 'HKLM:\SYSTEM\CurrentControlSet\Control\Print\Printers'
$script:WorkOfflineBit = 0x400   # PRINTER_ATTRIBUTE_WORK_OFFLINE

# ---------------------------------------------------------------------------
# The fault table. The detection trace lives next to the fault it describes:
# a fault whose trace nobody can restate is a fault nobody can trust on stage.
# ---------------------------------------------------------------------------
$script:Faults = @(
  [pscustomobject]@{
    Name     = 'printer-down'
    Summary  = 'Printer offline with jobs stuck behind it (the flagship demo fault)'
    Breaks   = 'Sets PRINTER_ATTRIBUTE_WORK_OFFLINE on the target queue, restarts Spooler, then parks N jobs in it'
    RedRow   = $true
    Say      = 'Clear the print queue on <branch>'
    Playbook = 'clear-print-queue (T3) genuinely drains the queue'
  },
  [pscustomobject]@{
    Name     = 'printer-offline'
    Summary  = 'Printer reports offline, empty queue'
    Breaks   = 'Sets PRINTER_ATTRIBUTE_WORK_OFFLINE in the printer registry key, restarts Spooler to load it'
    RedRow   = $true
    Say      = 'Why is the printer down in <branch>?'
    Playbook = 'no playbook clears an offline flag - use reset-faults.ps1'
  },
  [pscustomobject]@{
    Name     = 'spooler-stopped'
    Summary  = 'Print Spooler service stopped'
    Breaks   = 'Stop-Service Spooler'
    RedRow   = $false
    Say      = 'Restart the print spooler on <branch>'
    Playbook = 'restart-spooler (T3) genuinely repairs it - the only full loop in the kit'
  },
  [pscustomobject]@{
    Name     = 'vnc-down'
    Summary  = 'TightVNC service stopped, VNC column dot goes red'
    Breaks   = 'Stop-Service tvnserver'
    RedRow   = $false
    Say      = 'no voice fix exists for this one'
    Playbook = 'none - tvnserver is not in CONTROLLABLE_SERVICES; use reset-faults.ps1'
  }
)

# ---------------------------------------------------------------------------
# Output helpers.
# ---------------------------------------------------------------------------
function Write-Head {
  param([string]$Text)
  Write-Host ''
  Write-Host ('== ' + $Text) -ForegroundColor Cyan
}

function Write-Item {
  param([string]$Label, [string]$Value)
  Write-Host ('   ' + $Label.PadRight(22) + ' ' + $Value)
}

function Write-Warn {
  param([string]$Text)
  Write-Host ('   ! ' + $Text) -ForegroundColor Yellow
}

function Write-Bad {
  param([string]$Text)
  Write-Host ('   X ' + $Text) -ForegroundColor Red
}

function Write-Good {
  param([string]$Text)
  Write-Host ('   + ' + $Text) -ForegroundColor Green
}

function Show-FaultList {
  Write-Host ''
  Write-Host 'IT Sentinel fault simulation kit' -ForegroundColor Cyan
  Write-Host '--------------------------------'
  foreach ($f in $script:Faults) {
    Write-Host ''
    Write-Host ('  ' + $f.Name) -ForegroundColor White
    Write-Item 'what it is' $f.Summary
    Write-Item 'mechanism'  $f.Breaks
    if ($f.RedRow) {
      Write-Item 'fleet row' 'goes CRITICAL (red) - asset_health.status'
    } else {
      Write-Item 'fleet row' 'stays green - shows in the voice detail and the column dots only'
    }
    Write-Item 'alert row'     'no - ingest raises alerts only for enquest and endpointSecurity'
    Write-Item 'announcer'     'silent - AlertAnnouncer speaks p1/p2 only'
    Write-Item 'operator says' $f.Say
    Write-Item 'playbook'      $f.Playbook
  }
  Write-Host ''
  Write-Host '  NOT simulatable, and why. See docs/17-fault-simulation.md:' -ForegroundColor DarkGray
  Write-Host '   endpoint-security  Tamper Protection blocks it and disabling AV is a T6' -ForegroundColor DarkGray
  Write-Host '                      offence. Refused. It is also the ONLY fault that would' -ForegroundColor DarkGray
  Write-Host '                      raise a p1 and make the announcer speak.'              -ForegroundColor DarkGray
  Write-Host '   enquest-down       collect.ps1 hardcodes enquest status to "unknown", so a' -ForegroundColor DarkGray
  Write-Host '                      p3 enquest alert is ALREADY permanently open on every'   -ForegroundColor DarkGray
  Write-Host '                      machine. Breaking Enquest changes nothing.'              -ForegroundColor DarkGray
  Write-Host '   email-down         collect.ps1 hardcodes email status to "unknown" too.'    -ForegroundColor DarkGray
  Write-Host '   dns / network      nothing in ingest.service.ts reads hb.network.'          -ForegroundColor DarkGray
  Write-Host '   disk / ram         stored and shown as numbers, never used for status.'     -ForegroundColor DarkGray
  Write-Host ''
  Write-Host '  Undo everything: .\scripts\reset-faults.ps1'
  Write-Host ''
}

# ---------------------------------------------------------------------------
# Elevation. Detected and explained, never a bare access-denied stack trace.
# ---------------------------------------------------------------------------
function Test-Elevated {
  $id = [Security.Principal.WindowsIdentity]::GetCurrent()
  $principal = New-Object Security.Principal.WindowsPrincipal($id)
  return $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
}

function Assert-Elevated {
  if (Test-Elevated) { return }
  Write-Host ''
  Write-Bad 'This needs to run elevated.'
  Write-Host ''
  Write-Host '   Stopping services and writing the printer registry keys both require'
  Write-Host '   Administrator. -List and -WhatIf do not, which is why you got this far.'
  Write-Host ''
  Write-Host '   Open an Administrator PowerShell and run:'
  Write-Host ''
  Write-Host ('     cd "' + (Split-Path -Parent $PSScriptRoot) + '"')
  Write-Host ('     .\scripts\simulate-fault.ps1 -Fault ' + $Fault)
  Write-Host ''
  exit 1
}

# ---------------------------------------------------------------------------
# State. Written BEFORE the fault is applied, so a script that dies halfway
# still leaves reset-faults.ps1 everything it needs to put the machine back.
# ---------------------------------------------------------------------------
function Read-State {
  if (-not (Test-Path -LiteralPath $script:StatePath)) {
    return [pscustomobject]@{ version = 1; faults = [pscustomobject]@{} }
  }
  try {
    $raw = Get-Content -LiteralPath $script:StatePath -Raw
    if ([string]::IsNullOrWhiteSpace($raw)) { throw 'empty' }
    return ($raw | ConvertFrom-Json)
  } catch {
    Write-Warn ('Could not read ' + $script:StatePath + ' - starting a fresh state file.')
    return [pscustomobject]@{ version = 1; faults = [pscustomobject]@{} }
  }
}

function Write-State {
  param([psobject]$State)
  if (-not (Test-Path -LiteralPath $script:StateDir)) {
    New-Item -ItemType Directory -Path $script:StateDir -Force | Out-Null
  }
  ($State | ConvertTo-Json -Depth 8) | Set-Content -LiteralPath $script:StatePath -Encoding ASCII
}

function Set-FaultState {
  param([string]$Name, [psobject]$Value)
  $state = Read-State
  $state.faults | Add-Member -NotePropertyName $Name -NotePropertyValue $Value -Force
  Write-State -State $state
}

function Remove-FaultState {
  param([string]$Name)
  $state = Read-State
  if ($state.faults.PSObject.Properties.Name -contains $Name) {
    $state.faults.PSObject.Properties.Remove($Name)
    Write-State -State $state
  }
}

# ---------------------------------------------------------------------------
# Detection preview.
#
# The most useful thing in this script. It re-computes, on this machine, the
# exact expressions collect.ps1 and toHeartbeat() use, then applies
# deriveHealthStatus() to the result. If it says HEALTHY after you induced a
# fault, that fault will NOT show on the dashboard here - and you want to
# learn that during the dry run, not on stage.
#
#   collect.ps1 L41   online = -not $_.WorkOffline -and $_.PrinterStatus -ne 7
#   collect.ps1 L35   queueDepth = count of Win32_PrintJob LIKE '<name>%'
#   collect.ps1 L125  security.status = RealTimeProtectionEnabled ? healthy : critical
#   collect.ps1 L134  emailDetail.status is the literal 'unknown'
#   collect.ps1 L141  enquestDetail.status is the literal 'unknown'
#   main.ts           printer = no printers ? 'unknown' : any offline ? 'critical' : 'healthy'
#   ingest.service.ts deriveHealthStatus([printer, email, endpointSecurity, enquest])
# ---------------------------------------------------------------------------
function Get-CollectorView {
  # This function only reads. Shadowing $WhatIfPreference stops -WhatIf from
  # leaking into the CimCmdlets module auto-load, which otherwise buries the
  # preview under a dozen "What if: Set Alias" lines.
  $WhatIfPreference = $false

  $printers = @()
  try {
    $printers = @(Get-CimInstance Win32_Printer -ErrorAction Stop | ForEach-Object {
      $isOnline = (-not $_.WorkOffline) -and ($_.PrinterStatus -ne 7)
      $depth = 0
      try {
        $escaped = $_.Name -replace "'", "''"
        $depth = @(Get-CimInstance Win32_PrintJob -Filter ("Name LIKE '" + $escaped + "%'") -ErrorAction Stop).Count
      } catch {
        $depth = 0
      }
      [pscustomobject]@{ Name = $_.Name; Online = $isOnline; QueueDepth = $depth }
    })
  } catch {
    $printers = @()
  }

  if ($printers.Count -eq 0) {
    $printerWire = 'unknown'
  } elseif (@($printers | Where-Object { -not $_.Online }).Count -gt 0) {
    $printerWire = 'critical'
  } else {
    $printerWire = 'healthy'
  }

  $securityWire = 'critical'
  $securityProbeOk = $true
  try {
    $mp = Get-MpComputerStatus -ErrorAction Stop
    if ($mp -and $mp.RealTimeProtectionEnabled) { $securityWire = 'healthy' }
  } catch {
    # The probe itself failed (no Defender, or a third-party AV replaced it).
    # Say so rather than letting a failed probe read as a real fault.
    $securityWire = 'critical'
    $securityProbeOk = $false
  }

  $vnc = 'not installed'
  $vncSvc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
  if ($vncSvc) {
    if ($vncSvc.Status -eq 'Running') { $vnc = 'running' } else { $vnc = 'stopped' }
  }

  $services = @()
  foreach ($n in @('Spooler', 'WinRM', 'EventLog')) {
    $s = Get-Service -Name $n -ErrorAction SilentlyContinue
    $actual = 'unknown'
    if ($s) { $actual = $s.Status.ToString().ToLower() }
    $services += [pscustomobject]@{ Name = $n; Actual = $actual }
  }

  $subs = @($printerWire, 'unknown', $securityWire, 'unknown')
  if ($subs -contains 'critical') {
    $derived = 'critical'
  } elseif ($subs -contains 'warning') {
    $derived = 'warning'
  } else {
    $derived = 'healthy'
  }

  return [pscustomobject]@{
    Printers        = $printers
    Printer         = $printerWire
    Email           = 'unknown'
    Security        = $securityWire
    SecurityProbeOk = $securityProbeOk
    Enquest         = 'unknown'
    Tightvnc        = $vnc
    Services        = $services
    Derived         = $derived
  }
}

<#
  Verdict is 'red' (this fault must redden the row), 'notred' (it is known
  not to) or 'none' (just show the reading, as under -WhatIf).
#>
function Show-DetectionPreview {
  param([psobject]$View, [string]$Verdict = 'none')

  Write-Head 'Detection preview (what the next heartbeat will carry)'
  if ($View.Printers.Count -eq 0) {
    Write-Item 'printers seen' 'none - Win32_Printer returned nothing'
  } else {
    foreach ($p in $View.Printers) {
      $state = 'online'
      if (-not $p.Online) { $state = 'OFFLINE' }
      Write-Item 'printer' ($p.Name + '  [' + $state + ', ' + $p.QueueDepth + ' queued]')
    }
  }
  Write-Host ''
  Write-Item 'hb.printer' $View.Printer
  Write-Item 'hb.email'   ($View.Email + '   (hardcoded in collect.ps1)')
  if ($View.SecurityProbeOk) {
    Write-Item 'hb.endpointSecurity' $View.Security
  } else {
    Write-Item 'hb.endpointSecurity' ($View.Security + '   (PROBE FAILED here - Get-MpComputerStatus threw)')
  }
  Write-Item 'hb.enquest'  ($View.Enquest + '   (hardcoded in collect.ps1)')
  Write-Item 'hb.tightvnc' $View.Tightvnc
  foreach ($s in $View.Services) {
    Write-Item ('service ' + $s.Name) $s.Actual
  }
  Write-Host ''
  Write-Item 'asset_health.status' $View.Derived.ToUpper()

  if ($Verdict -eq 'red') {
    if ($View.Derived -eq 'critical') {
      Write-Good 'The fleet row WILL go red on the next heartbeat.'
    } else {
      Write-Bad  'The fleet row will NOT go red. This fault did not take on this machine.'
      Write-Warn 'Run .\scripts\reset-faults.ps1, then check the printer target before you present.'
    }
  } elseif ($Verdict -eq 'notred') {
    Write-Warn 'By design this fault does NOT redden the fleet row. It shows in the voice'
    Write-Warn 'detail answer and the column dots. See docs/17-fault-simulation.md.'
  }
  Write-Host ''
  Write-Item 'no alert row'  'ingest.service.ts raises alerts only for enquest and endpointSecurity'
  Write-Item 'no voice ping' 'AlertAnnouncer speaks p1/p2 only - nothing here reaches that bar'
}

# ---------------------------------------------------------------------------
# Printer plumbing.
#
# There are no *-PrintQueue cmdlets on Windows. PrintManagement ships
# Get-Printer / Get-PrintJob / Remove-PrintJob and nothing that pauses a
# queue, so holding jobs is done the way Windows itself does it: the
# WORK_OFFLINE attribute. That is also why printer-down sets the flag BEFORE
# submitting jobs - submitting first would print paper on a real device.
# ---------------------------------------------------------------------------
function Get-PrinterKeyPath {
  param([string]$Name)
  return (Join-Path $script:PrinterKeyRoot $Name)
}

function Get-PrinterAttributes {
  param([string]$Name)
  $key = Get-PrinterKeyPath -Name $Name
  if (-not (Test-Path -LiteralPath $key)) { return $null }
  $prop = Get-ItemProperty -LiteralPath $key -Name 'Attributes' -ErrorAction SilentlyContinue
  if (-not $prop) { return $null }
  return [int]$prop.Attributes
}

function Set-PrinterAttributes {
  param([string]$Name, [int]$Value)
  Set-ItemProperty -LiteralPath (Get-PrinterKeyPath -Name $Name) -Name 'Attributes' -Value $Value -Type DWord
}

<#
  Picks a driver that is actually installed. "Microsoft Print To PDF" is on a
  stock Windows 11, but an imaged corporate laptop can have it removed, and
  Add-Printer with a missing driver fails with an error that reads like a
  permissions problem.
#>
function Resolve-SimDriver {
  $installed = @(Get-PrinterDriver -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
  foreach ($candidate in @('Microsoft Print To PDF', 'Microsoft Print to PDF', 'Generic / Text Only', 'Microsoft XPS Document Writer v4')) {
    if ($installed -contains $candidate) { return $candidate }
  }
  if ($installed.Count -gt 0) { return $installed[0] }
  return $null
}

<#
  The simulation printer exists so no physical device is ever involved. Its
  port is nul:, so even if a job did release, nothing prints and no paper is
  wasted. Every printer fault targets it by default.
#>
function New-SimPrinter {
  if (Get-Printer -Name $script:SimPrinterName -ErrorAction SilentlyContinue) {
    return [pscustomobject]@{ Created = $false; CreatedPort = $false }
  }

  $driver = Resolve-SimDriver
  if (-not $driver) {
    throw 'No printer driver is installed on this machine, so the simulation printer cannot be created. Pass -Printer <name> to target a real queue instead.'
  }

  $createdPort = $false
  if (-not (Get-PrinterPort -Name 'nul:' -ErrorAction SilentlyContinue)) {
    Add-PrinterPort -Name 'nul:' -ErrorAction Stop
    $createdPort = $true
  }

  Add-Printer -Name $script:SimPrinterName -DriverName $driver -PortName 'nul:' -ErrorAction Stop
  Write-Good ('Created simulation printer "' + $script:SimPrinterName + '" on driver "' + $driver + '", port nul:')
  return [pscustomobject]@{ Created = $true; CreatedPort = $createdPort }
}

function Resolve-TargetPrinter {
  if ($Printer) {
    if ($Printer -like '\\*') {
      throw 'A network printer connection has no HKLM registry key, so the offline flag cannot be set on it. Target a local queue.'
    }
    if (-not (Get-Printer -Name $Printer -ErrorAction SilentlyContinue)) {
      throw ('No printer named "' + $Printer + '" on this machine. Run Get-Printer to see what is here.')
    }
    Write-Warn ('Targeting the real queue "' + $Printer + '". It is taken offline before any job is submitted, so nothing prints.')
    return [pscustomobject]@{ Name = $Printer; Created = $false; CreatedPort = $false }
  }
  $made = New-SimPrinter
  return [pscustomobject]@{ Name = $script:SimPrinterName; Created = $made.Created; CreatedPort = $made.CreatedPort }
}

# ---------------------------------------------------------------------------
# FAULT: printer-offline  (and the first half of printer-down)
#
# Detection trace, confirmed against the source:
#   1. HKLM\...\Print\Printers\<name>\Attributes gains PRINTER_ATTRIBUTE_
#      WORK_OFFLINE (0x400). The Spooler caches printers in memory, so it is
#      restarted to load the change.
#   2. collect.ps1 L41: online = -not $_.WorkOffline -and $_.PrinterStatus -ne 7
#      -> $false for this queue.
#   3. main.ts toHeartbeat(): anyPrinterFault = printers.some(p => !p.online)
#      -> true, so printer = "critical".
#   4. ingest.service.ts deriveHealthStatus(): substatuses contains "critical"
#      -> asset_health.status = "critical".
#   5. Console: FleetTable Printer dot red, row critical, BranchSidebar rolls
#      the branch up to critical.
#   6. Voice: /v1/voice/branch reports "printer fault"; /v1/voice/detail with
#      topic printer names the queue and its queue depth.
#   7. evaluateChecks() also inserts a printer_chain check row - note its
#      status is "warning", not "critical", because faultClass defaults to
#      "none" (collect.ps1 never sets one).
#   8. NO alert row. evaluateChecks raises alerts only for enquest and
#      endpointSecurity, so the AlertAnnouncer stays silent.
# ---------------------------------------------------------------------------
function Invoke-PrinterOffline {
  $target = Resolve-TargetPrinter
  $name = $target.Name

  $attrs = Get-PrinterAttributes -Name $name
  if ($null -eq $attrs) {
    throw ('No registry key for printer "' + $name + '" under ' + $script:PrinterKeyRoot + '. Only local queues can be flagged offline.')
  }

  # State first, action second.
  Set-FaultState -Name 'printer-offline' -Value ([pscustomobject]@{
    printer            = $name
    originalAttributes = $attrs
    createdPrinter     = $target.Created
    createdPort        = $target.CreatedPort
    appliedAt          = (Get-Date).ToString('o')
  })

  $applied = $false
  try {
    Set-PrinterAttributes -Name $name -Value ($attrs -bor $script:WorkOfflineBit)
    $applied = $true
    Restart-Service -Name Spooler -Force -ErrorAction Stop
    Start-Sleep -Seconds 3
  } catch {
    if ($applied) {
      Set-PrinterAttributes -Name $name -Value $attrs
      Start-Service -Name Spooler -ErrorAction SilentlyContinue
    }
    Remove-FaultState -Name 'printer-offline'
    throw
  }

  Write-Head 'Broken'
  Write-Item 'printer'  $name
  Write-Item 'flag set' ('PRINTER_ATTRIBUTE_WORK_OFFLINE (0x400): attributes ' + $attrs + ' -> ' + ($attrs -bor $script:WorkOfflineBit))
  Write-Item 'spooler'  'restarted so the attribute is loaded'
  return $name
}

# ---------------------------------------------------------------------------
# Parks dummy jobs behind an already-offline queue.
#
# Detection trace:
#   1. An offline queue holds jobs instead of printing them. That is what the
#      WORK_OFFLINE attribute is for, and it is why the flag is set first.
#   2. collect.ps1 L35 counts Win32_PrintJob per printer -> queueDepth.
#   3. ingest.service.ts evaluateChecks() writes queueDepth into the
#      printer_chain check row's detail.
#   4. Voice: TOPIC_REPORTS.printer speaks "<n> jobs queued", but only for a
#      printer it already considers faulty. That is satisfied here because
#      the queue is offline.
#
# HONEST LIMIT: queue depth on its own never changes hb.printer and never
# reddens the row. printer_chain's status is derived from p.online alone.
# Jobs are here because they are the one thing clear-print-queue can
# genuinely repair.
#
# NOTE ON collect.ps1: its queue filter is a prefix LIKE match
# ("Name LIKE '<printer>%'"), so two printers whose names share a prefix
# double-count each other's jobs. Not this script's bug, but it will make
# queue depths look wrong on a machine with "HP LaserJet" and
# "HP LaserJet (copy 1)".
# ---------------------------------------------------------------------------
function Invoke-QueueJobs {
  param([string]$TargetName)

  $tmp = Join-Path $env:TEMP 'it-sentinel-sim-job.txt'
  $lines = @(
    'IT SENTINEL FAULT SIMULATION',
    'A dummy job parked in an offline queue by scripts/simulate-fault.ps1.',
    'Removed by the clear-print-queue playbook or by scripts/reset-faults.ps1.'
  )
  Set-Content -LiteralPath $tmp -Value $lines -Encoding ASCII

  # Out-Printer only exists in Windows PowerShell 5.1 and this script must
  # also run under pwsh 7. Windows PowerShell is always present on Windows
  # 11, so shell out to it rather than carrying a winspool P/Invoke.
  $psExe = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
  $escapedName = $TargetName -replace "'", "''"
  $escapedTmp = $tmp -replace "'", "''"
  $submitted = 0

  try {
    if (-not (Test-Path -LiteralPath $psExe)) {
      Write-Warn 'Windows PowerShell 5.1 was not found, so no jobs could be submitted.'
      Write-Warn 'The printer will still report offline; there will just be nothing to clear.'
      return 0
    }
    $cmd = "Get-Content -LiteralPath '" + $escapedTmp + "' | Out-Printer -Name '" + $escapedName + "'"
    for ($i = 1; $i -le $Jobs; $i++) {
      & $psExe -NoProfile -NonInteractive -Command $cmd 2>$null | Out-Null
      $submitted++
      Start-Sleep -Milliseconds 250
    }
  } finally {
    Remove-Item -LiteralPath $tmp -Force -ErrorAction SilentlyContinue
  }

  Start-Sleep -Seconds 2
  $landed = @(Get-PrintJob -PrinterName $TargetName -ErrorAction SilentlyContinue).Count

  Set-FaultState -Name 'queued-jobs' -Value ([pscustomobject]@{
    printer   = $TargetName
    submitted = $submitted
    landed    = $landed
    appliedAt = (Get-Date).ToString('o')
  })

  Write-Item 'jobs submitted' ([string]$submitted + ' into the offline queue')
  Write-Item 'jobs in queue'  ([string]$landed + ' visible to Get-PrintJob right now')
  if ($landed -eq 0) {
    Write-Warn 'Nothing landed in the queue. The heartbeat will report queueDepth 0 and'
    Write-Warn 'clear-print-queue will have nothing to clear. Check the driver on this queue.'
  }
  return $landed
}

# ---------------------------------------------------------------------------
# FAULT: spooler-stopped
#
# Detection trace, confirmed against the source:
#   1. collect.ps1 L51-59 builds hb.services from Spooler, WinRM and EventLog
#      with expectedState 'running'. Spooler reports actualState 'stopped'.
#   2. Voice: TOPIC_REPORTS.services in voice.routes.ts says "1 of 3 monitored
#      services is not running: Spooler is stopped", and the section counts as
#      a problem area when the operator asks for the whole picture.
#   3. With the Spooler down, Get-CimInstance Win32_Printer normally returns
#      nothing, so printers[] is empty and hb.printer becomes "unknown" - the
#      Printer dot goes GREY, not red. The preview below reports which of the
#      two actually happens on this machine.
#
# HONEST LIMIT: nothing in deriveHealthStatus() reads hb.services, so the row
# stays green and no alert is raised. docs/15 sections 5.4 and 6 claim this
# fault reddens the row and makes the announcer speak. It does neither.
#
# This is the ONLY fault in the kit that restart-spooler genuinely repairs.
# ---------------------------------------------------------------------------
function Invoke-SpoolerStopped {
  $svc = Get-Service -Name 'Spooler' -ErrorAction SilentlyContinue
  if (-not $svc) { throw 'There is no Spooler service on this machine.' }

  Set-FaultState -Name 'spooler-stopped' -Value ([pscustomobject]@{
    wasRunning = ($svc.Status -eq 'Running')
    appliedAt  = (Get-Date).ToString('o')
  })

  try {
    Stop-Service -Name 'Spooler' -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
  } catch {
    Start-Service -Name 'Spooler' -ErrorAction SilentlyContinue
    Remove-FaultState -Name 'spooler-stopped'
    throw
  }

  Write-Head 'Broken'
  Write-Item 'service'  'Spooler stopped'
  Write-Item 'restores' 'the restart-spooler playbook, or reset-faults.ps1'
}

# ---------------------------------------------------------------------------
# FAULT: vnc-down
#
# Detection trace, confirmed against the source:
#   1. collect.ps1 L116: tightVncDetail.serviceRunning = tvnserver is Running.
#   2. main.ts: tightvnc = serviceRunning ? "running" : "stopped".
#   3. ingest.service.ts stores it as asset_health.tightvnc_status.
#   4. FleetTable.tsx renders the VNC column as
#      StatusDot(tightvncStatus === "running" ? "healthy" : "critical")
#      -> the VNC dot goes RED.
#
# HONEST LIMIT: deriveHealthStatus() does not include tightvnc, so the row
# status stays healthy and no alert is raised. tvnserver is not in
# CONTROLLABLE_SERVICES either, so there is no voice fix - only reset-faults.
# This also breaks remote desktop to this machine until you reset.
# ---------------------------------------------------------------------------
function Invoke-VncDown {
  $svc = Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
  if (-not $svc) {
    throw 'TightVNC (tvnserver) is not installed on this machine, so there is nothing to stop.'
  }

  Set-FaultState -Name 'vnc-down' -Value ([pscustomobject]@{
    wasRunning = ($svc.Status -eq 'Running')
    appliedAt  = (Get-Date).ToString('o')
  })

  try {
    Stop-Service -Name 'tvnserver' -Force -ErrorAction Stop
    Start-Sleep -Seconds 2
  } catch {
    Start-Service -Name 'tvnserver' -ErrorAction SilentlyContinue
    Remove-FaultState -Name 'vnc-down'
    throw
  }

  Write-Head 'Broken'
  Write-Item 'service' 'tvnserver stopped'
  Write-Warn 'Remote desktop to this machine will not work until you reset.'
}

# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
if ($List -or (-not $Fault)) {
  Show-FaultList
  if (-not $List) {
    Write-Host '  Pick one with -Fault <name>.' -ForegroundColor Yellow
    Write-Host ''
  }
  exit 0
}

$definition = $script:Faults | Where-Object { $_.Name -eq $Fault }
if (-not $definition) {
  Write-Bad ('Unknown fault "' + $Fault + '".')
  Show-FaultList
  exit 1
}

if (-not $PSCmdlet.ShouldProcess($env:COMPUTERNAME, ('Induce fault "' + $Fault + '": ' + $definition.Breaks))) {
  Write-Host ''
  Write-Host ('WhatIf: would induce "' + $Fault + '" on ' + $env:COMPUTERNAME) -ForegroundColor Yellow
  Write-Item 'mechanism'     $definition.Breaks
  Write-Item 'operator says' $definition.Say
  Write-Item 'playbook'      $definition.Playbook
  Write-Host ''
  Write-Host 'WhatIf: nothing was changed. The machine reads as follows right now.' -ForegroundColor Yellow
  Show-DetectionPreview -View (Get-CollectorView) -Verdict 'none'
  exit 0
}

Assert-Elevated

Write-Host ''
Write-Host ('IT Sentinel fault simulation: ' + $Fault) -ForegroundColor Cyan
Write-Host ('Machine: ' + $env:COMPUTERNAME)

$failed = $false
try {
  switch ($Fault) {
    'printer-offline' {
      Invoke-PrinterOffline | Out-Null
    }
    'printer-down' {
      $name = Invoke-PrinterOffline
      Invoke-QueueJobs -TargetName $name | Out-Null
    }
    'spooler-stopped' {
      Invoke-SpoolerStopped
    }
    'vnc-down' {
      Invoke-VncDown
    }
    default {
      throw ('Fault "' + $Fault + '" is listed but not implemented. That is a bug in this script.')
    }
  }
} catch {
  $failed = $true
  Write-Host ''
  Write-Bad ('Fault "' + $Fault + '" failed: ' + $_.Exception.Message)
  Write-Warn 'Any partial change was rolled back. Run .\scripts\reset-faults.ps1 to be certain.'
} finally {
  if (-not $failed -and -not $SkipVerify) {
    $verdict = 'notred'
    if ($definition.RedRow) { $verdict = 'red' }
    Show-DetectionPreview -View (Get-CollectorView) -Verdict $verdict
  }

  if (-not $failed) {
    Write-Head 'On stage'
    Write-Item 'time to show'  'one heartbeat interval - HEARTBEAT_INTERVAL_MS, 15s in the demo .env'
    Write-Item 'operator says' $definition.Say
    Write-Item 'playbook'      $definition.Playbook
    Write-Host ''
    Write-Host '   Get back to green:  .\scripts\reset-faults.ps1' -ForegroundColor Green
    Write-Host ''
  }
}

if ($failed) { exit 1 }
exit 0
