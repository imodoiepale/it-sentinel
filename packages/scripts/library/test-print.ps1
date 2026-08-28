# Tier: T2 Diagnose. Read-only from the executor's perspective (sends a
# single test page, does not modify configuration or state).
$printer = Get-CimInstance Win32_Printer | Where-Object { $_.Default -eq $true } | Select-Object -First 1
if (-not $printer) {
  [pscustomobject]@{ error = 'no default printer configured' } | ConvertTo-Json -Compress
  exit 1
}
Invoke-CimMethod -InputObject $printer -MethodName PrintTestPage | Out-Null
[pscustomobject]@{ printer = $printer.Name; result = 'test page sent' } | ConvertTo-Json -Compress
