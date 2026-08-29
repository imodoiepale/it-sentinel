-- Moving a machine to a different branch, without creating a second one.
--
-- Until this migration a machine's branch was decided exactly once, by
-- SENTINEL_BRANCH_SLUG in the agent's .env at install time, and there was no
-- way back. A laptop enrolled against the wrong slug stayed at the wrong
-- branch on the board forever; editing the .env on the machine did not move
-- it either, because ingest looks assets up by (site_id, hostname) and simply
-- auto-provisioned a SECOND row at the new site. The operator was left with
-- one physical machine appearing at two branches, neither of them wrong
-- enough to obviously be the duplicate.
--
-- So the roster, not the endpoint's .env, becomes the authority on where a
-- machine lives: this function is how that authority is exercised, and
-- ingest.service.ts now keeps whatever site the roster says (see the comment
-- there about the hostname lookup). The agent's claimed slug becomes a hint
-- that gets logged when it disagrees, rather than a fact that silently
-- re-homes or duplicates a row.
--
-- Same shape as retire_asset/restore_asset in 0027 and for the same reasons:
-- SECURITY DEFINER so the role check cannot be skipped by talking to the
-- table directly, idempotent so a repeated voice turn does not write history
-- twice, and audited because a machine changing branch changes who can see
-- it.

-- ------------------------------------------------------------- reassign ---

create or replace function public.reassign_asset(
  p_asset_id uuid,
  p_site_id  uuid,
  p_reason   text default null,
  p_actor_id uuid default null
)
returns table (
  asset_id        uuid,
  hostname        text,
  from_site_id    uuid,
  from_site_name  text,
  to_site_id      uuid,
  to_site_name    text,
  already_there   boolean,
  alerts_moved    integer,
  incidents_moved integer
)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
declare
  v_caller    uuid := auth.uid();
  v_actor     uuid;
  v_from      uuid;
  v_from_name text;
  v_to_name   text;
  v_host      text;
  v_role_from text;
  v_role_to   text;
  v_alerts    integer := 0;
  v_incidents integer := 0;
begin
  -- p_actor_id is honoured only for the service-role callers that have no
  -- JWT of their own (the voice webhook, which resolves a real operator via
  -- resolveVoiceOperator). Accepting it from a logged-in session would be an
  -- attribution hole: an operator could move a machine and have the audit row
  -- name somebody else.
  if v_caller is not null then
    v_actor := v_caller;
  else
    v_actor := p_actor_id;
  end if;

  if v_actor is null then
    raise exception 'reassign_asset requires an actor' using errcode = '28000';
  end if;

  select a.site_id, a.hostname into v_from, v_host
  from public.assets a
  where a.id = p_asset_id;

  if v_from is null then
    raise exception 'asset % not found', p_asset_id using errcode = 'P0002';
  end if;

  -- Resolved before the role check so "that branch does not exist" never
  -- comes back as "you are not allowed", which would send an operator
  -- hunting for a permission problem they do not have.
  select s.name into v_to_name from public.sites s where s.id = p_site_id;
  if v_to_name is null then
    raise exception 'site % not found', p_site_id using errcode = 'P0002';
  end if;
  select s.name into v_from_name from public.sites s where s.id = v_from;

  -- The role is checked at BOTH ends, because a reassignment is two changes:
  -- the machine leaves one branch and arrives at another. Checking only the
  -- destination would let an operator who administers Dubai reach into Lagos
  -- — a branch they cannot even read — and pull a machine out of it, which is
  -- an exfiltration path dressed up as a records fix: once the asset is at
  -- their site, its health, telemetry and sessions all become visible to them
  -- through the ordinary site-scoped RLS policies. Checking only the source
  -- would be the mirror of the same hole, planting a machine into a branch
  -- whose operators never agreed to own it.
  --
  -- Same three roles as retirement: this is a registry change, not a
  -- remediation, so l1/l2 support are out, and auditors read the trail rather
  -- than reshape it.
  select sa.role into v_role_from
  from public.site_access sa
  where sa.operator_id = v_actor and sa.site_id = v_from;

  if v_role_from is null or v_role_from not in ('l3_sysadmin', 'security_admin', 'it_manager') then
    raise exception 'operator % may not move assets out of site %', v_actor, v_from
      using errcode = '42501';
  end if;

  select sa.role into v_role_to
  from public.site_access sa
  where sa.operator_id = v_actor and sa.site_id = p_site_id;

  if v_role_to is null or v_role_to not in ('l3_sysadmin', 'security_admin', 'it_manager') then
    raise exception 'operator % may not move assets into site %', v_actor, p_site_id
      using errcode = '42501';
  end if;

  -- Idempotent on purpose, and checked after the role check so the answer to
  -- "may I?" never depends on where the machine already is. A double-clicked
  -- button, or a voice turn repeated because the operator did not hear the
  -- reply, must not append a second audit row claiming the machine moved
  -- twice — recurrence and audit both read that history as fact.
  if v_from = p_site_id then
    return query select p_asset_id, v_host, v_from, v_from_name, p_site_id, v_to_name, true, 0, 0;
    return;
  end if;

  -- assets declares `unique (site_id, hostname)`, so a destination that
  -- already has this hostname makes the update fail. Caught here rather than
  -- left to the constraint because the raw error names an index
  -- ("assets_site_id_hostname_key") and nothing an operator can act on,
  -- whereas the real situation — two machines genuinely share a name, or the
  -- machine was already re-enrolled at the destination and this is the
  -- orphaned original — needs a human decision about which row survives.
  --
  -- Retired rows count. The unique constraint does not exclude them, and
  -- neither does this: a retired duplicate at the destination will still
  -- block the move, and saying so beats the update failing underneath.
  if exists (
    select 1 from public.assets a
    where a.site_id = p_site_id and a.hostname = v_host and a.id <> p_asset_id
  ) then
    raise exception '% already has a machine called %', v_to_name, v_host
      using errcode = '23505';
  end if;

  -- No check on decommissioned_at. Correcting the branch of a retired machine
  -- is a records fix — it makes the historical rows resolve to the right
  -- place — and retirement is a flag on the roster, not a lock on the row.

  update public.assets a
  set site_id    = p_site_id,
      updated_at = now()
  where a.id = p_asset_id;

  -- Open alerts and incidents travel WITH the machine; closed ones do not.
  --
  -- An open alert carries its own site_id, which is what the console filters
  -- on and what alerts_read_scoped (migration 0007) checks. Leaving it behind
  -- would render a live fault under the branch the machine just left, and —
  -- worse — hide it from the operators who now own the machine, since they
  -- may have no grant at the old site at all. The fault is a property of the
  -- machine, and the machine is here now.
  --
  -- Resolved, closed and suppressed rows deliberately keep the OLD site_id.
  -- They are the record of something that actually happened at that branch on
  -- that day, and recurrence.service.ts reads exactly those resolved
  -- incidents to say "seen 3 times: 2 at Lagos, 1 at Nairobi". Rewriting them
  -- would relocate history to a branch where it never occurred and quietly
  -- corrupt the one signal an operator uses to decide whether a fix holds.
  update public.alerts al
  set site_id = p_site_id
  where al.asset_id = p_asset_id and al.status in ('open', 'acknowledged');
  get diagnostics v_alerts = row_count;

  update public.incidents i
  set site_id = p_site_id
  where i.asset_id = p_asset_id and i.status in ('open', 'in_progress');
  get diagnostics v_incidents = row_count;

  -- Two tables are deliberately NOT touched here:
  --
  --  * asset_health has no site_id at all — it is keyed by asset_id, so the
  --    fleet table follows the asset for free. Noted so nobody goes looking
  --    for the update that "must be missing".
  --  * checks and telemetry are append-only measurements stamped with where
  --    the machine was when they were taken. Rewriting them would make a
  --    branch's history change shape every time a laptop moved desks; new
  --    rows already carry the new site because ingest passes asset.site_id.

  insert into public.audit_log (actor_id, actor_kind, action, target_type, target_id, decision, detail)
  values (
    v_actor,
    'operator',
    'asset.reassigned',
    'asset',
    p_asset_id,
    'confirmed',
    jsonb_build_object(
      'hostname',        v_host,
      -- Both ends recorded, because "moved to Dubai" is only half an answer
      -- when the question later is "who took this machine out of Lagos".
      'from_site_id',    v_from,
      'from_site_name',  v_from_name,
      'to_site_id',      p_site_id,
      'to_site_name',    v_to_name,
      'reason',          p_reason,
      'via',             case when v_caller is null then 'service_role' else 'operator_session' end,
      'alerts_moved',    v_alerts,
      'incidents_moved', v_incidents
    )
  );

  return query select p_asset_id, v_host, v_from, v_from_name, p_site_id, v_to_name, false, v_alerts, v_incidents;
end;
$$;

-- As with 0027: no direct update policy on assets is added anywhere, so this
-- function is the only way an operator session can change site_id, which is
-- what makes the two-ended role check and the audit row unavoidable rather
-- than customary.
revoke all on function public.reassign_asset(uuid, uuid, text, uuid) from public, anon;
grant execute on function public.reassign_asset(uuid, uuid, text, uuid) to authenticated, service_role;
