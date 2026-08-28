<#
  Runs on the target machine via Invoke-Command (WinRM/PS-remoting) from
  agent-less. Emits one JSON object matching HeartbeatPayload's detail
  fields (packages/contracts/src/heartbeat.ts) — the Node side wraps this
  with the summary fields and posts it to /v1/heartbeat unchanged in shape.

  Deliberately read-only: every cmdlet here inspects state, none of them
  change it. agent-less has no write/elevated-execution surface — that is
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
  $jobs = Get-SafeValue { (Get-CimInstance Win32_PrintJob -Filter "Name LIKE '$($_.Name -replace \"'\", \"''\")%'").Count } 0
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

$updates = Get-SafeValue {
  $searcher = New-Object -ComObject Microsoft.Update.Searcher
  $result = $searcher.Search("IsInstalled=0")
  $result.Updates.Count
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
  storage = [ordered]@{ volumes = $volumes }
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
    portReachable = (Get-SafeValue { (Test-NetConnection -ComputerName 'localhost' -Port 5900 -WarningAction SilentlyContinue).TcpTestSucceeded } $false)
  }
  security = [ordered]@{
    product = (Get-SafeValue { $defender.AMServiceEnabled ? 'Windows Defender' : $null })
    serviceRunning = (Get-SafeValue { $defender.AMServiceEnabled } $false)
    protectionEnabled = (Get-SafeValue { $defender.RealTimeProtectionEnabled } $false)
    definitionsAgeHours = (Get-SafeValue { [math]::Round(((Get-Date) - $defender.AntivirusSignatureLastUpdated).TotalHours, 1) })
    tamperProtectionEnabled = (Get-SafeValue { $defender.IsTamperProtected })
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
