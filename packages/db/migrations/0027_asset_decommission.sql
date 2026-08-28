-- Taking a machine out of the fleet: retire the row, never delete it.
--
-- The obvious implementation of "remove this PC from the roster" is
-- `delete from public.assets`, and it is the one implementation this system
-- must not offer. The foreign keys say why out loud: command_runs, sessions,
-- telemetry, alerts, checks, playbook_runs and _session_tokens all reference
-- assets `on delete cascade`. A single delete therefore destroys every
-- elevated command ever run on that machine, every remote-control session
-- ever opened against it, and every heartbeat it ever sent. audit_log itself
-- survives — target_id carries no FK — but its rows become unreadable: an
-- auditor holding "adhoc_powershell on 6f2c…" has no way left to learn which
-- machine that was, who owned it, or that it ever existed.
--
-- Attribution after the fact is this product's central security claim. A
-- routine "remove PC" button that quietly erases the record of what was run
-- on a machine would make destroying the evidence easier than reading it,
-- and the person most motivated to press it is the person who has something
-- to hide. So retirement is a reversible flag, gated on role, and audited —
-- and there is deliberately no delete path anywhere in the application.

alter table public.assets
  add column if not exists decommissioned_at timestamptz,
  add column if not exists decommissioned_by uuid references auth.users(id),
  add column if not exists decommission_reason text;

comment on column public.assets.decommissioned_at is
  'Set when the asset is retired from the roster. Non-null rows are excluded from fleet reads but remain joinable so historical audit rows still resolve a hostname.';

-- Partial, because every roster read is now "the active ones at this site"
-- and the retired rows only ever matter one at a time, by id, from history.
create index if not exists assets_active_site_idx
  on public.assets (site_id) where decommissioned_at is null;

-- Note what is NOT changed here: assets_read_scoped (migration 0007) still
-- returns retired rows. Hiding them at the RLS layer would look tidier and
-- would silently break every `assets!inner(...)` embed in the console — the
-- hostname column of an audit view would simply stop rendering, taking the
-- audit rows with it. Exclusion belongs in the roster queries, which know
-- they are asking "what is in the fleet"; RLS answers "may this operator see
-- this machine", and the answer to that does not change when it is retired.

-- ---------------------------------------------------------------- retire ---

create or replace function public.retire_asset(
  p_asset_id uuid,
  p_reason   text default null,
  p_actor_id uuid default null
)
returns table (
  asset_id          uuid,
  hostname          text,
  site_id           uuid,
  decommissioned_at timestamptz,
  already_retired   boolean
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller uuid := auth.uid();
  v_actor  uuid;
  v_role   text;
  v_site   uuid;
  v_host   text;
  v_prior  timestamptz;
  v_when   timestamptz;
  v_closed integer := 0;
begin
  -- p_actor_id is honoured only for the service-role callers that have no
  -- JWT of their own (the voice webhook, which resolves a real operator via
  -- resolveVoiceOperator). Accepting it from a logged-in session would be an
  -- attribution hole: an operator could retire a machine and have the audit
  -- row name somebody else.
  if v_caller is not null then
    v_actor := v_caller;
  else
    v_actor := p_actor_id;
  end if;

  if v_actor is null then
    raise exception 'retire_asset requires an actor' using errcode = '28000';
  end if;

  select a.site_id, a.hostname, a.decommissioned_at
    into v_site, v_host, v_prior
  from public.assets a
  where a.id = p_asset_id;

  if v_site is null then
    raise exception 'asset % not found', p_asset_id using errcode = 'P0002';
  end if;

  -- The role is checked against the actor's grant at the asset's own site
  -- whichever door the call came through, so the voice path can never retire
  -- something the same person would be refused for in the console. l1 and l2
  -- support are excluded because taking a machine off the board is a
  -- registry change rather than a remediation, and auditors because their
  -- whole point is to read the trail, not to reshape it.
  select sa.role into v_role
  from public.site_access sa
  where sa.operator_id = v_actor and sa.site_id = v_site;

  if v_role is null or v_role not in ('l3_sysadmin', 'security_admin', 'it_manager') then
    raise exception 'operator % may not retire assets at site %', v_actor, v_site
      using errcode = '42501';
  end if;

  -- Idempotent on purpose. A double-clicked button, or a voice turn repeated
  -- because the operator did not hear the answer, must not rewrite who
  -- retired the machine or add a second audit row claiming it happened twice.
  if v_prior is not null then
    return query select p_asset_id, v_host, v_site, v_prior, true;
    return;
  end if;

  update public.assets a
  set decommissioned_at   = now(),
      decommissioned_by   = v_actor,
      decommission_reason = p_reason,
      updated_at          = now()
  where a.id = p_asset_id
  returning a.decommissioned_at into v_when;

  -- An open session row against a machine that is no longer in the fleet is
  -- a dangling claim on the trail, and an unredeemed token is a live key to a
  -- box we have just declared out of scope. Both are closed here.
  --
  -- What this does NOT do is tear down a relay connection that is already
  -- established: the relay holds a redeemed socket, not a row it re-checks.
  -- Retirement is a registry action, not a kill switch — the kill switch is
  -- scripts/uninstall-sentinel-agent.ps1, run on the machine itself.
  update public.sessions s
  set ended_at = now()
  where s.asset_id = p_asset_id and s.ended_at is null;
  get diagnostics v_closed = row_count;

  update public._session_tokens t
  set redeemed = true, redeemed_at = now()
  where t.asset_id = p_asset_id and not t.redeemed;

  -- No `tier` on this row. The tier scale grades what a command is allowed to
  -- execute on an endpoint; retirement executes nothing on the endpoint, and
  -- stamping it T3 to make the column non-null would mislead exactly the
  -- person the column exists for.
  insert into public.audit_log (actor_id, actor_kind, action, target_type, target_id, decision, detail)
  values (
    v_actor,
    'operator',
    'asset.decommissioned',
    'asset',
    p_asset_id,
    'confirmed',
    jsonb_build_object(
      'hostname',        v_host,
      'site_id',         v_site,
      'reason',          p_reason,
      'via',             case when v_caller is null then 'service_role' else 'operator_session' end,
      'sessions_closed', v_closed
    )
  );

  return query select p_asset_id, v_host, v_site, v_when, false;
end;
$$;

-- --------------------------------------------------------------- restore ---

-- The counterpart exists because retirement is reversible and deletion is
-- not, which is half the argument for the flag: a machine retired by mistake
-- at 4pm on demo day has to be back on the board in one call, with both the
-- mistake and the correction in the log.
create or replace function public.restore_asset(
  p_asset_id uuid,
  p_reason   text default null,
  p_actor_id uuid default null
)
returns table (
  asset_id uuid,
  hostname text,
  site_id  uuid,
  restored boolean
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller uuid := auth.uid();
  v_actor  uuid;
  v_role   text;
  v_site   uuid;
  v_host   text;
  v_prior  timestamptz;
begin
  if v_caller is not null then
    v_actor := v_caller;
  else
    v_actor := p_actor_id;
  end if;

  if v_actor is null then
    raise exception 'restore_asset requires an actor' using errcode = '28000';
  end if;

  select a.site_id, a.hostname, a.decommissioned_at
    into v_site, v_host, v_prior
  from public.assets a
  where a.id = p_asset_id;

  if v_site is null then
    raise exception 'asset % not found', p_asset_id using errcode = 'P0002';
  end if;

  select sa.role into v_role
  from public.site_access sa
  where sa.operator_id = v_actor and sa.site_id = v_site;

  if v_role is null or v_role not in ('l3_sysadmin', 'security_admin', 'it_manager') then
    raise exception 'operator % may not restore assets at site %', v_actor, v_site
      using errcode = '42501';
  end if;

  if v_prior is null then
    return query select p_asset_id, v_host, v_site, false;
    return;
  end if;

  update public.assets a
  set decommissioned_at   = null,
      decommissioned_by   = null,
      decommission_reason = null,
      updated_at          = now()
  where a.id = p_asset_id;

  insert into public.audit_log (actor_id, actor_kind, action, target_type, target_id, decision, detail)
  values (
    v_actor,
    'operator',
    'asset.recommissioned',
    'asset',
    p_asset_id,
    'confirmed',
    jsonb_build_object(
      'hostname',            v_host,
      'site_id',             v_site,
      'reason',              p_reason,
      'via',                 case when v_caller is null then 'service_role' else 'operator_session' end,
      'was_decommissioned_at', v_prior
    )
  );

  return query select p_asset_id, v_host, v_site, true;
end;
$$;

-- No direct update policy on assets is added anywhere: these two functions
-- are the only way an operator session can set the flag, which is what makes
-- the role check and the audit row unavoidable rather than customary.
revoke all on function public.retire_asset(uuid, text, uuid) from public, anon;
revoke all on function public.restore_asset(uuid, text, uuid) from public, anon;
grant execute on function public.retire_asset(uuid, text, uuid) to authenticated, service_role;
grant execute on function public.restore_asset(uuid, text, uuid) to authenticated, service_role;

-- ----------------------------------------------------------- sweep fixup ---

-- Without this clause a retired laptop alerts forever. sweep_stale_assets
-- (migration 0008) exists so a silent agent never renders as healthy, and a
-- machine that has been uninstalled is silent by definition — so every five
-- minutes it would be re-flipped to 'stale', which is the one status the
-- system is built to make impossible to ignore. Retirement is the operator
-- saying "this silence is expected"; the sweep has to hear that.
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
    and (last_heartbeat_at is null or last_heartbeat_at < now() - interval '5 minutes')
    and exists (
      select 1 from public.assets a
      where a.id = asset_health.asset_id and a.decommissioned_at is null
    );
end;
$$;
