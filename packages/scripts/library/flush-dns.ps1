# Tier: T3 Remediate. Idempotent, reversible (cache simply repopulates).
Clear-DnsClientCache
[pscustomobject]@{ action = 'flush-dns'; result = 'cache cleared' } | ConvertTo-Json -Compress
