-- Single-use, short-lived tokens minted by session.service.ts and redeemed
-- exactly once by the relay. Deliberately has NO RLS policies (RLS is
-- enabled with zero grants) — only the service-role connection touches this
-- table, since service_role bypasses RLS entirely by Postgres/Supabase
-- design. No operator or agent JWT can read or write it under any policy.
create table public._session_tokens (
  token uuid primary key,
  session_id uuid not null references public.sessions(id) on delete cascade,
  asset_id uuid not null references public.assets(id) on delete cascade,
  credential_id uuid not null references public.credentials(id),
  expires_at timestamptz not null,
  redeemed boolean not null default false,
  redeemed_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public._session_tokens enable row level security;
-- No policies created — deny-all for anon/authenticated by construction.

create index session_tokens_expiry_idx on public._session_tokens (expires_at) where not redeemed;

-- Redeem-once semantics as a single atomic function, callable only by
-- service_role (the relay's own backend connection), so there is no
-- window where two relay processes could both consume the same token.
create or replace function public.redeem_session_token(p_token uuid)
returns table (session_id uuid, asset_id uuid, credential_id uuid)
language plpgsql
security definer
set search_path = public, pg_catalog
as $$
begin
  return query
  update public._session_tokens t
  set redeemed = true, redeemed_at = now()
  where t.token = p_token
    and not t.redeemed
    and t.expires_at > now()
  returning t.session_id, t.asset_id, t.credential_id;
end;
$$;

revoke all on function public.redeem_session_token(uuid) from public, anon, authenticated;
grant execute on function public.redeem_session_token(uuid) to service_role;
