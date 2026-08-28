-- pgmq lives in its own schema, not exposed to PostgREST by default. These
-- thin wrappers are what apps/control-plane/src/orchestrator actually calls
-- via supabase-js .rpc(), restricted to service_role like the vault path.

create or replace function public.enqueue_command(p_message jsonb)
returns bigint
language sql
security definer
set search_path = public, pgmq, pg_catalog
as $$
  select pgmq.send('agent_commands', p_message);
$$;

create or replace function public.dequeue_commands(p_visibility_timeout_seconds int, p_max_messages int)
returns table (msg_id bigint, message jsonb, read_ct int, enqueued_at timestamptz)
language sql
security definer
set search_path = public, pgmq, pg_catalog
as $$
  select msg_id, message, read_ct, enqueued_at
  from pgmq.read('agent_commands', p_visibility_timeout_seconds, p_max_messages);
$$;

create or replace function public.ack_command(p_msg_id bigint)
returns boolean
language sql
security definer
set search_path = public, pgmq, pg_catalog
as $$
  select pgmq.delete('agent_commands', p_msg_id);
$$;

revoke all on function public.enqueue_command(jsonb) from public, anon, authenticated;
revoke all on function public.dequeue_commands(int, int) from public, anon, authenticated;
revoke all on function public.ack_command(bigint) from public, anon, authenticated;
grant execute on function public.enqueue_command(jsonb) to service_role;
grant execute on function public.dequeue_commands(int, int) to service_role;
grant execute on function public.ack_command(bigint) to service_role;
