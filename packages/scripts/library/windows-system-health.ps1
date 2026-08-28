# Tier: T2 Diagnose. Read-only system health snapshot.
$os = Get-CimInstance Win32_OperatingSystem
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='C:'"
[pscustomobject]@{
  uptimeHours = [math]::Round(((Get-Date) - $os.LastBootUpTime).TotalHours, 1)
  freeMemoryPercent = [math]::Round(($os.FreePhysicalMemory * 1KB) / $os.TotalVisibleMemorySize / 1KB * 100, 1)
  systemDriveFreePercent = if ($disk.Size -gt 0) { [math]::Round(($disk.FreeSpace / $disk.Size) * 100, 1) } else { $null }
} | ConvertTo-Json -Compress
