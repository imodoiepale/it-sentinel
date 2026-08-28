-- Fixes from get_advisors after 0001-0011:
--
-- 1. ERROR: pg_partman's daily child partitions of `telemetry` do NOT inherit
--    RLS from the parent for PostgREST access — each partition is its own
--    relation with its own RLS flag. Every existing child is fixed here, and
--    a function is scheduled to run daily (right after pg_partman's own
--    maintenance) to secure any newly created partition automatically.
-- 2. WARN: several SECURITY DEFINER functions had a mutable search_path and
--    were callable by anon/authenticated via PostgREST RPC when they should
--    only run under pg_cron or the service role. Locked down.

create or replace function public.secure_telemetry_partitions()
returns void
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  part record;
begin
  for part in
    select inhrelid::regclass::text as partition_name
    from pg_inherits
    where inhparent = 'public.telemetry'::regclass
  loop
    execute format('alter table %s enable row level security', part.partition_name);

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = split_part(part.partition_name, '.', 2)
        and policyname = 'telemetry_part_read_scoped'
    ) then
      execute format(
        'create policy telemetry_part_read_scoped on %s for select using (exists (select 1 from public.assets a where a.id = asset_id and public.has_site_access(a.site_id)))',
        part.partition_name
      );
    end if;

    if not exists (
      select 1 from pg_policies
      where schemaname = 'public' and tablename = split_part(part.partition_name, '.', 2)
        and policyname = 'telemetry_part_write_own_agent'
    ) then
      execute format(
        'create policy telemetry_part_write_own_agent on %s for insert with check (asset_id = public.current_agent_asset_id())',
        part.partition_name
      );
    end if;
  end loop;
end;
$$;

select public.secure_telemetry_partitions();

-- Run daily, shortly after pg_partman's own maintenance creates tomorrow's
-- partitions, so every new partition is secured before it can hold data.
select cron.schedule('partman-maintenance', '0 1 * * *', $$call partman.run_maintenance_proc();$$);
select cron.schedule('secure-telemetry-partitions', '10 1 * * *', $$select public.secure_telemetry_partitions();$$);

-- Pin search_path on every SECURITY DEFINER function we own.
alter function public.has_site_access(uuid) set search_path = public, pg_catalog;
alter function public.current_agent_asset_id() set search_path = public, pg_catalog;
alter function public.sweep_stale_assets() set search_path = public, pg_catalog;
alter function public.nightly_rollup() set search_path = public, pg_catalog;
alter function public.decrypt_credential_for_session(uuid, uuid) set search_path = public, vault, pg_catalog;
alter function public.store_credential(text, text, text, uuid, uuid, integer) set search_path = public, vault, pg_catalog;
alter function public.secure_telemetry_partitions() set search_path = public, pg_catalog;

-- sweep_stale_assets / nightly_rollup / secure_telemetry_partitions are
-- pg_cron-only maintenance jobs — never meant to be invoked via the
-- PostgREST RPC surface by anon or authenticated.
revoke all on function public.sweep_stale_assets() from public, anon, authenticated;
revoke all on function public.nightly_rollup() from public, anon, authenticated;
revoke all on function public.secure_telemetry_partitions() from public, anon, authenticated;

-- has_site_access / current_agent_asset_id are read-only helpers used
-- *inside* RLS policies, which requires authenticated to retain EXECUTE —
-- but anon (unauthenticated) has no business calling them directly.
revoke all on function public.has_site_access(uuid) from anon;
revoke all on function public.current_agent_asset_id() from anon;

-- pgaudit's own internal event-trigger functions have no business being
-- reachable via the PostgREST RPC surface either.
revoke all on function public.pgaudit_ddl_command_end() from public, anon, authenticated;
revoke all on function public.pgaudit_sql_drop() from public, anon, authenticated;
