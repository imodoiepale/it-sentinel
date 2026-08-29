<#
  Runs on the target machine via Invoke-Command (WinRM/PS-remoting) from
  agent-less. Emits one JSON object matching HeartbeatPayload's detail
  fields (packages/contracts/src/heartbeat.ts) -- the Node side wraps this
  with the summary fields and posts it to /v1/heartbeat unchanged in shape.

  Deliberately read-only: every cmdlet here inspects state, none of them
  change it. agent-less has no write/elevated-execution surface -- that is
  agent-node's job once it is deployed to a branch.
#>

$ErrorActionPreference = 'SilentlyContinue'

function Get-SafeValue {
  param([scriptblock]$Block, $Default = $null)
  try { & $Block } catch { $Default }
}

$cs = Get-CimInstance Win32_ComputerSystem
$os = Get-CimInstance Win32_OperatingSystem
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$bios = Get-CimInstance Win32_BIOS

$volumes = Get-CimInstance Win32_LogicalDisk -Filter "DriveType=3" | ForEach-Object {
  [ordered]@{
    drive = $_.DeviceID
    capacityMb = [math]::Round($_.Size / 1MB)
    freeMb = [math]::Round($_.FreeSpace / 1MB)
    freePercent = if ($_.Size -gt 0) { [math]::Round(($_.FreeSpace / $_.Size) * 100, 1) } else { 0 }
  }
}

$defender = Get-SafeValue { Get-MpComputerStatus }
$printers = Get-CimInstance Win32_Printer | ForEach-Object {
  # See apps/agent-node/src/collect.ps1: the inlined -replace used C-style \"
  # escapes, which PowerShell does not recognise, so the string terminated
  # early and the whole file failed to parse.
  $printerName = $_.Name -replace "'", "''"
  $jobs = Get-SafeValue { (Get-CimInstance Win32_PrintJob -Filter "Name LIKE '$printerName,%'").Count } 0
  [ordered]@{
    name = $_.Name
    driver = $_.DriverName
    port = $_.PortName
    isDefault = [bool]$_.Default
    online = -not $_.WorkOffline -and $_.PrinterStatus -ne 7
    queueDepth = if ($jobs) { $jobs } else { 0 }
    errorState = if ($_.DetectedErrorState -and $_.DetectedErrorState -ne 0) { "$($_.DetectedErrorState)" } else { $null }
  }
}

$gateway = Get-SafeValue { (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).NextHop }
$dns = Get-SafeValue { (Get-DnsClientServerAddress -AddressFamily IPv4 | Where-Object { $_.ServerAddresses.Count -gt 0 } | Select-Object -First 1).ServerAddresses }
$ping = Get-SafeValue { Test-Connection -ComputerName 8.8.8.8 -Count 1 -ErrorAction Stop }

$requiredServices = @('Spooler', 'WinRM', 'EventLog')
$services = $requiredServices | ForEach-Object {
  $svc = Get-Service -Name $_ -ErrorAction SilentlyContinue
  [ordered]@{
    name = $_
    expectedState = 'running'
    actualState = if ($svc) { $svc.Status.ToString().ToLower() } else { 'unknown' }
  }
}

# Cached for an hour, on disk.
#
# Microsoft.Update.Searcher is the single most expensive call in this script
# and the least predictable: measured between 8s and 30s on the same machine
# depending on whether it decides to reach the network. Paying that on every
# heartbeat is what pushed the collector past its execution timeout, and
# raising the timeout only moves the cliff because the variance is unbounded.
#
# The pending-update count does not change minute to minute, so an hourly
# refresh loses nothing real. A stale cache is served if the search fails, so
# a transient WU outage degrades to an old number rather than to no heartbeat.
$updatesCachePath = Join-Path $env:TEMP 'sentinel-updates-count.txt'
$updates = Get-SafeValue {
  $cached = $null
  if (Test-Path $updatesCachePath) {
    $age = (Get-Date) - (Get-Item $updatesCachePath).LastWriteTime
    $cached = [int](Get-Content $updatesCachePath -Raw).Trim()
    if ($age.TotalHours -lt 1) { return $cached }
  }
  try {
    $searcher = New-Object -ComObject Microsoft.Update.Searcher
    $count = $searcher.Search("IsInstalled=0").Updates.Count
    Set-Content -Path $updatesCachePath -Value $count -Encoding ASCII
    $count
  } catch {
    if ($null -ne $cached) { $cached } else { 0 }
  }
} 0

$recentEvents = Get-SafeValue {
  Get-WinEvent -FilterHashtable @{ LogName = 'Application', 'System'; Level = 1, 2; StartTime = (Get-Date).AddMinutes(-15) } -MaxEvents 20 |
    ForEach-Object {
      [ordered]@{
        source = $_.ProviderName
        level = if ($_.Level -eq 1) { 'critical' } else { 'error' }
        eventId = $_.Id
        message = ($_.Message -split "`n")[0]
        occurredAt = $_.TimeCreated.ToUniversalTime().ToString('o')
        count = 1
      }
    }
} @()

$result = [ordered]@{
  hostname = $env:COMPUTERNAME
  machine = [ordered]@{
    hostname = $env:COMPUTERNAME
    serial = (Get-SafeValue { $bios.SerialNumber })
    model = (Get-SafeValue { $cs.Model })
    manufacturer = (Get-SafeValue { $cs.Manufacturer })
  }
  cpu = [ordered]@{
    model = (Get-SafeValue { $cpu.Name })
    usagePercent = (Get-SafeValue { (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average } 0)
    coreCount = (Get-SafeValue { $cpu.NumberOfCores })
  }
  ram = [ordered]@{
    installedMb = [math]::Round($cs.TotalPhysicalMemory / 1MB)
    availableMb = [math]::Round($os.FreePhysicalMemory / 1KB)
    usagePercent = [math]::Round((1 - ($os.FreePhysicalMemory * 1KB) / $cs.TotalPhysicalMemory) * 100, 1)
  }
  # @() is load-bearing. ConvertTo-Json serialises a one-element collection
  # as a bare object rather than an array, so a machine with a single disk
  # sent storage.volumes as an object and failed contract validation - while
  # a two-disk machine passed. printers and services already had this; only
  # volumes was missed, and only single-disk machines ever showed it.
  storage = [ordered]@{ volumes = @($volumes) }
  windows = [ordered]@{
    version = $os.Caption
    build = $os.BuildNumber
    activationStatus = 'unknown'
    uptimeSeconds = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalSeconds)
    rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
  }
  network = [ordered]@{
    linkState = if ($gateway) { 'lan' } else { 'disconnected' }
    gatewayIp = $gateway
    dnsServers = @($dns)
    internetReachable = [bool]($ping -and $ping.StatusCode -eq 0)
    internetLatencyMs = (Get-SafeValue { $ping.ResponseTime })
  }
  tightVncDetail = [ordered]@{
    installed = [bool](Get-Service -Name 'tvnserver' -ErrorAction SilentlyContinue)
    serviceRunning = (Get-SafeValue { (Get-Service -Name 'tvnserver' -ErrorAction Stop).Status -eq 'Running' } $false)
    # A raw TcpClient with a 1s deadline, not Test-NetConnection. That cmdlet
    # takes ~7.5s to report a CLOSED port because it runs its full diagnostic
    # suite, and on a machine where TightVNC is not yet installed that is the
    # normal path, not the exception. Together with the Windows Update search
    # it pushed collect.ps1 past the agent's execution timeout, and a killed
    # process writes nothing to stderr - so the whole collector failed with
    # "no output at all" and no clue why.
    portReachable = (Get-SafeValue {
      $probe = New-Object System.Net.Sockets.TcpClient
      try {
        $async = $probe.BeginConnect('127.0.0.1', 5900, $null, $null)
        if ($async.AsyncWaitHandle.WaitOne(1000, $false)) { $probe.EndConnect($async); $true } else { $false }
      } catch { $false } finally { $probe.Close() }
    } $false)
  }
  security = [ordered]@{
    # if/else rather than a ternary: `?:` is PowerShell 7 only, and
    # agent-less runs this same collector through WinRM, where the remote
    # session is Windows PowerShell 5.1 by default and would fail to parse
    # the whole file.
    product = (Get-SafeValue { if ($defender.AMServiceEnabled) { 'Windows Defender' } else { $null } })
    serviceRunning = (Get-SafeValue { $defender.AMServiceEnabled } $false)
    protectionEnabled = (Get-SafeValue { $defender.RealTimeProtectionEnabled } $false)
    definitionsAgeHours = (Get-SafeValue { [math]::Round(((Get-Date) - $defender.AntivirusSignatureLastUpdated).TotalHours, 1) })
    tamperProtectionEnabled = (Get-SafeValue { $defender.IsTamperProtected })
    # Actually ask. The contract defaults this to [] when absent, and the
    # collector never sent it - so every machine reported an empty list, and
    # the voice route read empty as "the firewall is disabled" and announced a
    # breach on healthy machines. Reporting the real profiles makes empty mean
    # empty.
    firewallProfilesEnabled = (Get-SafeValue {
      @(Get-NetFirewallProfile -ErrorAction Stop | Where-Object { $_.Enabled } | ForEach-Object { [string]$_.Name })
    } @())
    status = if ($defender -and $defender.RealTimeProtectionEnabled) { 'healthy' } else { 'critical' }
  }
  printers = @($printers)
  emailDetail = [ordered]@{
    clientInstalled = [bool](Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)
    profileConfigured = $false
    serverReachable = $false
    authOk = $false
    processRunning = [bool](Get-Process -Name OUTLOOK -ErrorAction SilentlyContinue)
    status = 'unknown'
  }
  enquestDetail = [ordered]@{
    installed = [bool](Get-Process -Name Enquest -ErrorAction SilentlyContinue)
    processRunning = [bool](Get-Process -Name Enquest -ErrorAction SilentlyContinue)
    databaseReachable = $false
    syncServiceRunning = $false
    status = 'unknown'
  }
  services = @($services)
  updates = [ordered]@{
    pendingCount = $updates
    pendingSecurityCount = 0
    failedCount = 0
    rebootPending = (Test-Path 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Component Based Servicing\RebootPending')
  }
  recentEvents = @($recentEvents)
  user = [ordered]@{
    loggedInUser = (Get-SafeValue { (Get-CimInstance Win32_ComputerSystem).UserName })
    sessionState = 'active'
  }
}

$result | ConvertTo-Json -Depth 8 -Compress
