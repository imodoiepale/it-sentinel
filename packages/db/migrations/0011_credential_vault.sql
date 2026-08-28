-- Private credentials manager. Operators (IT Manager / Security Admin) create
-- and rotate credentials through this layer; the plaintext secret is stored
-- exclusively in supabase_vault (libsodium-encrypted at rest) and is NEVER
-- readable through this table, through PostgREST, or by the Sentinel Agent's
-- database role. Only the control-plane's service-role backend can decrypt,
-- and only at the moment of minting a session (session.service.ts) — never
-- returned to a browser, never logged, never handed to the AI agent.

create table public.credentials (
  id uuid primary key default gen_random_uuid(),
  label text not null,
  credential_type text not null check (credential_type in ('vnc', 'windows_admin', 'winrm', 'other')),
  site_id uuid references public.sites(id) on delete cascade,
  asset_id uuid references public.assets(id) on delete cascade,
  vault_secret_id uuid not null, -- references vault.secrets.id; the actual value lives there, encrypted
  created_by uuid references auth.users(id),
  rotation_policy_days integer default 90,
  last_rotated_at timestamptz not null default now(),
  expires_at timestamptz,
  is_active boolean not null default true,
  created_at timestamptz not null default now(),
  check (site_id is not null or asset_id is not null)
);
comment on table public.credentials is 'Metadata only. The secret value is never a column here — it lives in vault.secrets, decrypted only by decrypt_credential_for_session() under the service role.';

create unique index credentials_asset_type_active_idx on public.credentials (asset_id, credential_type) where is_active and asset_id is not null;

create table public.credential_rotation_log (
  id uuid primary key default gen_random_uuid(),
  credential_id uuid not null references public.credentials(id) on delete cascade,
  rotated_by uuid references auth.users(id),
  reason text,
  rotated_at timestamptz not null default now()
);

alter table public.assets add constraint assets_credential_id_fkey
  foreign key (credential_id) references public.credentials(id) on delete set null;

alter table public.credentials enable row level security;
alter table public.credential_rotation_log enable row level security;

-- Metadata (label, type, rotation date) is visible to managers/security admins
-- for governance — but note: metadata never includes the secret value itself.
create policy credentials_read_privileged on public.credentials for select
  using (
    exists (
      select 1 from public.site_access sa
      where sa.operator_id = auth.uid()
        and sa.role in ('it_manager', 'security_admin')
        and (
          sa.site_id = credentials.site_id
          or exists (select 1 from public.assets a where a.id = credentials.asset_id and a.site_id = sa.site_id)
        )
    )
  );

create policy credentials_write_privileged on public.credentials for insert
  with check (
    exists (
      select 1 from public.site_access sa
      where sa.operator_id = auth.uid() and sa.role in ('it_manager', 'security_admin')
    )
  );

create policy credentials_update_privileged on public.credentials for update
  using (
    exists (
      select 1 from public.site_access sa
      where sa.operator_id = auth.uid() and sa.role in ('it_manager', 'security_admin')
    )
  );

create policy rotation_log_read_privileged on public.credential_rotation_log for select
  using (
    exists (
      select 1 from public.site_access sa
      where sa.operator_id = auth.uid() and sa.role in ('it_manager', 'security_admin', 'auditor')
    )
  );

-- Store a new credential's plaintext into the vault and record its metadata
-- row in one call. Runs as the caller (it_manager/security_admin only, per
-- the insert policy above) but the secret itself never returns from this
-- function — only the new credential row's id.
create or replace function public.store_credential(
  p_label text,
  p_credential_type text,
  p_secret text,
  p_site_id uuid default null,
  p_asset_id uuid default null,
  p_rotation_policy_days integer default 90
)
returns uuid
language plpgsql
security invoker
as $$
declare
  v_secret_id uuid;
  v_credential_id uuid;
begin
  v_secret_id := vault.create_secret(p_secret, p_label || '-' || gen_random_uuid()::text);

  insert into public.credentials (label, credential_type, site_id, asset_id, vault_secret_id, created_by, rotation_policy_days)
  values (p_label, p_credential_type, p_site_id, p_asset_id, v_secret_id, auth.uid(), p_rotation_policy_days)
  returning id into v_credential_id;

  insert into public.audit_log (actor_id, actor_kind, action, target_type, target_id, decision, detail)
  values (auth.uid(), 'operator', 'credential.created', 'credential', v_credential_id, 'allowed',
          jsonb_build_object('label', p_label, 'credential_type', p_credential_type));

  return v_credential_id;
end;
$$;

-- The ONLY path that ever returns a decrypted secret value. Deliberately
-- SECURITY DEFINER and granted to service_role exclusively — see the revoke
-- statements below. Called server-side by session.service.ts at the moment
-- a VNC/terminal session is granted; the decrypted value is used in-process
-- by the relay to complete RFB auth and is never persisted or returned to
-- the operator's browser or to any Sentinel Agent tool.
create or replace function public.decrypt_credential_for_session(
  p_credential_id uuid,
  p_session_id uuid
)
returns text
language plpgsql
security definer
as $$
declare
  v_secret text;
  v_vault_secret_id uuid;
begin
  select vault_secret_id into v_vault_secret_id
  from public.credentials
  where id = p_credential_id and is_active;

  if v_vault_secret_id is null then
    raise exception 'credential not found or inactive';
  end if;

  if not exists (select 1 from public.sessions where id = p_session_id) then
    raise exception 'no session record — decrypt_credential_for_session must be called with a minted session id';
  end if;

  select decrypted_secret into v_secret from vault.decrypted_secrets where id = v_vault_secret_id;

  insert into public.audit_log (actor_kind, action, target_type, target_id, decision, detail)
  values ('system', 'credential.decrypted_for_session', 'credential', p_credential_id, 'allowed',
          jsonb_build_object('session_id', p_session_id));

  return v_secret;
end;
$$;

-- Lock the decrypt path down to the control-plane's service-role connection
-- only. Neither the browser (anon/authenticated), nor an agent's scoped JWT,
-- nor the Sentinel Agent's tool-calling role can ever call this function —
-- they simply have no EXECUTE grant, at the database level, unconditionally.
revoke all on function public.decrypt_credential_for_session(uuid, uuid) from public, anon, authenticated;
grant execute on function public.decrypt_credential_for_session(uuid, uuid) to service_role;

revoke all on function public.store_credential(text, text, text, uuid, uuid, integer) from public, anon;
grant execute on function public.store_credential(text, text, text, uuid, uuid, integer) to authenticated;

-- vault.decrypted_secrets is itself a privileged view; make sure nothing
-- but service_role (used only inside decrypt_credential_for_session above,
-- which is SECURITY DEFINER) can read it directly.
revoke all on vault.decrypted_secrets from public, anon, authenticated;
