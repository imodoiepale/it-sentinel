# Tier: T3 Remediate. Clears stuck print jobs only — does not touch the
# printer configuration itself. Idempotent: clearing an empty queue is a no-op.
Get-Printer | ForEach-Object {
  Get-PrintJob -PrinterName $_.Name -ErrorAction SilentlyContinue | Remove-PrintJob -ErrorAction SilentlyContinue
}
[pscustomobject]@{ action = 'clear-print-queue'; result = 'completed' } | ConvertTo-Json -Compress
