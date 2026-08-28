-- Append-only, insert-only audit log beneath pgaudit. Nothing may update or delete a row here.
create table public.audit_log (
  id uuid primary key default gen_random_uuid(),
  actor_id uuid references auth.users(id),
  actor_kind text not null default 'operator' check (actor_kind in ('operator','agent','sentinel_agent','system')),
  action text not null,
  target_type text,
  target_id uuid,
  tier text check (tier in ('T0','T1','T2','T3','T4','T5','T6')),
  decision text check (decision in ('allowed','denied','confirmed','approved')),
  detail jsonb not null default '{}',
  created_at timestamptz not null default now()
);
create index audit_log_actor_idx on public.audit_log (actor_id, created_at desc);
create index audit_log_target_idx on public.audit_log (target_type, target_id, created_at desc);

revoke update, delete on public.audit_log from public, anon, authenticated;

-- RAG knowledge base: runbooks + resolved incidents, embedded for the assistant.
create table public.knowledge (
  id uuid primary key default gen_random_uuid(),
  source_type text not null check (source_type in ('runbook','resolved_incident','playbook_doc')),
  source_id uuid,
  title text not null,
  content text not null,
  embedding vector(1536),
  created_at timestamptz not null default now()
);
create index knowledge_embedding_idx on public.knowledge using hnsw (embedding vector_cosine_ops);
