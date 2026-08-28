-- Console directives: how the voice agent drives the operator's screen.
--
-- "Open Lagos" has to make something happen in a browser the voice agent
-- has no connection to. Rather than pushing a session grant through the
-- voice path (which would mean a single-use VNC token travelling through
-- ElevenLabs' infrastructure and expiring in 90s before anyone clicks),
-- the voice route writes a directive row here and the console — already
-- subscribed to Supabase Realtime, see apps/web/lib/realtime.ts — reacts by
-- requesting the session itself, under the logged-in operator's own JWT.
--
-- The credential path is therefore unchanged: the browser still gets its
-- token from /v1/sessions, still never sees a secret, and the audit trail
-- still records the human operator rather than "the voice agent".

create table if not exists public.console_directives (
  id          uuid primary key default gen_random_uuid(),
  operator_id uuid references auth.users(id) on delete cascade,
  kind        text not null check (kind in ('open_machine', 'open_cameras', 'focus_branch', 'announce')),
  site_id     uuid references public.sites(id) on delete cascade,
  asset_id    uuid references public.assets(id) on delete cascade,
  payload     jsonb not null default '{}'::jsonb,
  consumed    boolean not null default false,
  created_at  timestamptz not null default now()
);

create index if not exists console_directives_pending_idx
  on public.console_directives (operator_id, created_at desc)
  where consumed = false;

alter table public.console_directives enable row level security;

-- An operator sees only directives addressed to them. Directives with a null
-- operator_id are fleet-wide (the "open all cameras" broadcast) and visible
-- to any authenticated operator who has at least one site grant.
drop policy if exists console_directives_select on public.console_directives;
create policy console_directives_select on public.console_directives
  for select to authenticated
  using (
    operator_id = auth.uid()
    or (operator_id is null and exists (select 1 from public.site_access sa where sa.operator_id = auth.uid()))
  );

-- Only the operator it is addressed to may mark it consumed.
drop policy if exists console_directives_update on public.console_directives;
create policy console_directives_update on public.console_directives
  for update to authenticated
  using (operator_id = auth.uid() or operator_id is null)
  with check (operator_id = auth.uid() or operator_id is null);

-- Inserts come from the control plane under service_role, which bypasses
-- RLS. No insert policy for authenticated is granted on purpose: a browser
-- must not be able to fabricate directives for another operator's screen.

alter publication supabase_realtime add table public.console_directives;
