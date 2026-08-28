-- pgtap suite: RLS must deny cross-site reads, and an agent JWT must not be
-- able to write another asset's row. Run with: pg_prove -d <db> rls.test.sql
-- (or via `supabase test db` once the local stack is running).

begin;
create extension if not exists pgtap;
select plan(6);

-- Fixtures
insert into public.sites (id, name, slug) values
  ('00000000-0000-0000-0000-000000000001', 'Test Branch A', 'test-branch-a'),
  ('00000000-0000-0000-0000-000000000002', 'Test Branch B', 'test-branch-b');

insert into public.assets (id, site_id, hostname, asset_type) values
  ('00000000-0000-0000-0000-0000000000a1', '00000000-0000-0000-0000-000000000001', 'A-POS-01', 'pos'),
  ('00000000-0000-0000-0000-0000000000b1', '00000000-0000-0000-0000-000000000002', 'B-POS-01', 'pos');

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000aa', 'operator-a@test.local')
on conflict do nothing;

insert into public.site_access (operator_id, site_id, role) values
  ('00000000-0000-0000-0000-0000000000aa', '00000000-0000-0000-0000-000000000001', 'l2_support');

-- As operator A (scoped to Branch A only)
set local role authenticated;
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated"}', true);

select is(
  (select count(*)::int from public.sites),
  1,
  'operator A sees exactly their one scoped site'
);

select is(
  (select count(*)::int from public.assets where site_id = '00000000-0000-0000-0000-000000000002'),
  0,
  'operator A cannot read assets belonging to a site they are not scoped to'
);

select is(
  (select count(*)::int from public.assets where site_id = '00000000-0000-0000-0000-000000000001'),
  1,
  'operator A can read assets on their own scoped site'
);

-- As an agent device bound to asset A1 only
select set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-0000000000aa","role":"authenticated","agent_asset_id":"00000000-0000-0000-0000-0000000000a1"}', true);

select lives_ok(
  $$insert into public.asset_health (asset_id, online) values ('00000000-0000-0000-0000-0000000000a1', true)$$,
  'agent JWT can write asset_health for its own bound asset_id'
);

select throws_ok(
  $$insert into public.asset_health (asset_id, online) values ('00000000-0000-0000-0000-0000000000b1', true)$$,
  '42501',
  null,
  'agent JWT cannot write asset_health for a different asset_id than its own bound claim'
);

select throws_ok(
  $$insert into public.telemetry (asset_id, payload) values ('00000000-0000-0000-0000-0000000000b1', '{}'::jsonb)$$,
  '42501',
  null,
  'agent JWT cannot write telemetry for a different asset than its own'
);

select * from finish();
rollback;
