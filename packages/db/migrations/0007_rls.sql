-- Deny-by-default everywhere. Operators are scoped via site_access; agents
-- authenticate with a per-device JWT restricted to their own asset_id via
-- the `agent_asset_id` custom claim (set when the device cert is issued).

alter table public.sites enable row level security;
alter table public.assets enable row level security;
alter table public.site_access enable row level security;
alter table public.asset_health enable row level security;
alter table public.telemetry enable row level security;
alter table public.checks enable row level security;
alter table public.alerts enable row level security;
alter table public.incidents enable row level security;
alter table public.incident_events enable row level security;
alter table public.sessions enable row level security;
alter table public.command_runs enable row level security;
alter table public.playbooks enable row level security;
alter table public.playbook_runs enable row level security;
alter table public.audit_log enable row level security;
alter table public.knowledge enable row level security;

-- Helper: does the current operator have access to this site?
create or replace function public.has_site_access(target_site_id uuid)
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1 from public.site_access sa
    where sa.operator_id = auth.uid() and sa.site_id = target_site_id
  );
$$;

-- Helper: the asset_id bound to the currently-authenticated agent device JWT.
create or replace function public.current_agent_asset_id()
returns uuid
language sql
stable
as $$
  select nullif(current_setting('request.jwt.claims', true)::jsonb ->> 'agent_asset_id', '')::uuid;
$$;

-- sites / assets: readable only within the operator's scoped sites.
create policy sites_read_scoped on public.sites for select
  using (public.has_site_access(id));

create policy assets_read_scoped on public.assets for select
  using (public.has_site_access(site_id));

create policy site_access_read_own on public.site_access for select
  using (operator_id = auth.uid());

-- asset_health / telemetry / checks: operator read within scope;
-- agent write restricted to its own bound asset_id only.
create policy asset_health_read_scoped on public.asset_health for select
  using (exists (select 1 from public.assets a where a.id = asset_id and public.has_site_access(a.site_id)));

create policy asset_health_write_own_agent on public.asset_health for insert with check (asset_id = public.current_agent_asset_id());
create policy asset_health_update_own_agent on public.asset_health for update
  using (asset_id = public.current_agent_asset_id())
  with check (asset_id = public.current_agent_asset_id());

create policy telemetry_read_scoped on public.telemetry for select
  using (exists (select 1 from public.assets a where a.id = asset_id and public.has_site_access(a.site_id)));
create policy telemetry_write_own_agent on public.telemetry for insert with check (asset_id = public.current_agent_asset_id());

create policy checks_read_scoped on public.checks for select
  using (site_id is null or public.has_site_access(site_id));
create policy checks_write_own_agent on public.checks for insert with check (asset_id = public.current_agent_asset_id());

-- alerts / incidents: read within scope; writes go through the control
-- plane's service role, not directly from operator sessions.
create policy alerts_read_scoped on public.alerts for select
  using (site_id is null or public.has_site_access(site_id));
create policy incidents_read_scoped on public.incidents for select
  using (site_id is null or public.has_site_access(site_id));
create policy incident_events_read_scoped on public.incident_events for select
  using (exists (select 1 from public.incidents i where i.id = incident_id and (i.site_id is null or public.has_site_access(i.site_id))));

-- sessions / command_runs: operator sees their own plus anything on a scoped site; auditor sees all scoped.
create policy sessions_read_scoped on public.sessions for select
  using (
    operator_id = auth.uid()
    or exists (select 1 from public.assets a where a.id = asset_id and public.has_site_access(a.site_id))
  );
create policy command_runs_read_scoped on public.command_runs for select
  using (
    operator_id = auth.uid()
    or exists (select 1 from public.assets a where a.id = asset_id and public.has_site_access(a.site_id))
  );

-- playbooks: readable by anyone with any site access (they're not secret); runs scoped like commands.
create policy playbooks_read_all_authenticated on public.playbooks for select
  using (auth.role() = 'authenticated');
create policy playbook_runs_read_scoped on public.playbook_runs for select
  using (exists (select 1 from public.assets a where a.id = asset_id and public.has_site_access(a.site_id)));

-- audit_log: insert-only for service role; readable by auditors and it_managers across all their scoped sites.
create policy audit_log_read_privileged on public.audit_log for select
  using (
    exists (
      select 1 from public.site_access sa
      where sa.operator_id = auth.uid() and sa.role in ('auditor', 'it_manager', 'security_admin')
    )
  );

-- knowledge: readable by any authenticated operator (feeds the assistant's RAG for everyone).
create policy knowledge_read_all_authenticated on public.knowledge for select
  using (auth.role() = 'authenticated');
