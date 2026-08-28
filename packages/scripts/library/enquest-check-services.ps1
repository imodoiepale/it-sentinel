# Tier: T2 Diagnose. Read-only inspection of the Enquest process and any
# service named with an Enquest prefix — does not restart or modify anything.
$process = Get-Process -Name Enquest -ErrorAction SilentlyContinue
$services = Get-Service | Where-Object { $_.Name -like 'Enquest*' } | Select-Object Name, Status
[pscustomobject]@{
  processRunning = [bool]$process
  services = @($services | ForEach-Object { [pscustomobject]@{ name = $_.Name; status = $_.Status.ToString() } })
} | ConvertTo-Json -Compress -Depth 4
