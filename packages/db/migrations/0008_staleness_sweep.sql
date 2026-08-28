-- The single most important correctness job in the system: a silent agent
-- must never render as healthy. This runs every 5 minutes and flips any
-- asset_health row whose last_heartbeat_at has aged past the threshold to
-- 'stale' — a distinct fourth state, never collapsed into 'healthy'.

create or replace function public.sweep_stale_assets()
returns void
language plpgsql
security definer
as $$
begin
  update public.asset_health
  set status = 'stale',
      printer_status = case when printer_status <> 'stale' then 'stale' else printer_status end,
      email_status = case when email_status <> 'stale' then 'stale' else email_status end,
      endpoint_security_status = case when endpoint_security_status <> 'stale' then 'stale' else endpoint_security_status end,
      enquest_status = case when enquest_status <> 'stale' then 'stale' else enquest_status end,
      updated_at = now()
  where status <> 'stale'
    and (last_heartbeat_at is null or last_heartbeat_at < now() - interval '5 minutes');
end;
$$;

select cron.schedule('sweep-stale-assets', '*/5 * * * *', $$select public.sweep_stale_assets();$$);

-- Nightly rollup placeholder — extended once incident-cause analytics land (build step 13).
create or replace function public.nightly_rollup()
returns void
language plpgsql
security definer
as $$
begin
  -- Populated by later migrations as reporting requirements are implemented.
  perform 1;
end;
$$;

select cron.schedule('nightly-rollup', '15 0 * * *', $$select public.nightly_rollup();$$);
