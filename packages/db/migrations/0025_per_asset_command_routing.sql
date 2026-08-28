-- Per-asset command routing.
--
-- The original dequeue_commands() popped from the single shared
-- 'agent_commands' queue with no filter, so with more than one agent running
-- ANY agent could receive ANY other agent's command. Harmless with a single
-- placeholder asset; silently catastrophic across a real fleet — a spooler
-- restart aimed at Lagos would execute on whichever machine polled first.
--
-- pgmq 1.4+ exposes a `conditional jsonb` argument on read() that matches
-- against the message body. Every CommandRequest already carries assetId
-- (see packages/contracts/src/command.ts), so filtering on it is exact and
-- needs no schema change to the queue itself.
--
-- The old 2-arg signature is dropped rather than kept as an overload: leaving
-- it callable would mean a stale agent build could still drain other
-- machines' work, which is precisely the failure this migration exists to
-- remove.

drop function if exists public.dequeue_commands(int, int);

create or replace function public.dequeue_commands(
  p_asset_id uuid,
  p_visibility_timeout_seconds int,
  p_max_messages int
)
returns table (msg_id bigint, message jsonb, read_ct int, enqueued_at timestamptz)
language sql
security definer
set search_path = public, pgmq, pg_catalog
as $$
  select msg_id, message, read_ct, enqueued_at
  from pgmq.read(
    'agent_commands',
    p_visibility_timeout_seconds,
    p_max_messages,
    jsonb_build_object('assetId', p_asset_id::text)
  );
$$;

revoke all on function public.dequeue_commands(uuid, int, int) from public, anon, authenticated;
grant execute on function public.dequeue_commands(uuid, int, int) to service_role;
