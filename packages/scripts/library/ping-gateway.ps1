# Tier: T2 Diagnose. Read-only.
$gateway = (Get-NetRoute -DestinationPrefix '0.0.0.0/0' | Select-Object -First 1).NextHop
if (-not $gateway) {
  [pscustomobject]@{ error = 'no default gateway found' } | ConvertTo-Json -Compress
  exit 1
}
$result = Test-Connection -ComputerName $gateway -Count 4
[pscustomobject]@{
  gateway = $gateway
  averageLatencyMs = ($result | Measure-Object -Property ResponseTime -Average).Average
  packetLoss = 4 - $result.Count
} | ConvertTo-Json -Compress
