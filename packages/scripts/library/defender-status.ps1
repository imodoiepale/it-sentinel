# Tier: T2 Diagnose. Read-only — reports status, never changes Defender configuration.
$status = Get-MpComputerStatus
[pscustomobject]@{
  realTimeProtectionEnabled = $status.RealTimeProtectionEnabled
  antivirusSignatureAgeHours = [math]::Round(((Get-Date) - $status.AntivirusSignatureLastUpdated).TotalHours, 1)
  tamperProtectionEnabled = $status.IsTamperProtected
} | ConvertTo-Json -Compress
