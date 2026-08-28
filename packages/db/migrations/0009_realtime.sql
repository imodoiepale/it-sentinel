-- Realtime publication limited exactly to what apps/web/lib/realtime.ts
-- subscribes to. Nothing else is broadcast.
alter publication supabase_realtime add table public.asset_health;
alter publication supabase_realtime add table public.alerts;
alter publication supabase_realtime add table public.incidents;
alter publication supabase_realtime add table public.sessions;
