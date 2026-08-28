# Tier: T3 Remediate. Idempotent — restarting an already-running spooler is safe.
# Rollback: N/A (service restarts are not destructive); verification below.
Restart-Service -Name Spooler -Force
Start-Sleep -Seconds 2
$svc = Get-Service -Name Spooler
[pscustomobject]@{ service = 'Spooler'; status = $svc.Status.ToString() } | ConvertTo-Json -Compress
