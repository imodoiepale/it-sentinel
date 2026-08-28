-- Demo-fleet bootstrap for the Kafé Kasa hackathon.
--
-- The live project had the full schema applied but ZERO rows in the three
-- tables that gate every code path:
--   auth.users   = 0  -> nobody can log into the console at all
--   site_access  = 0  -> evaluateCommandPolicy() denies EVERY command
--   credentials  = 0  -> requestSession() throws "no credential configured"
-- None of these surface as errors until demo time, where they look like
-- crashes rather than missing config.
--
-- PREREQUISITE, do this first and it takes 20 seconds:
--   Supabase Dashboard -> Authentication -> Users -> "Add user"
--   Email: itsentinel.kenya@gmail.com   (tick "Auto Confirm User")
-- The operator account is deliberately NOT created here. Minting a bcrypt
-- hash straight into auth.users bypasses GoTrue, whose internal columns
-- differ between versions, and would put a real login password in a file
-- tracked by git. The dashboard is both safer and more reliable.
--
-- Idempotent: safe to re-run.

-- ------------------------------------------------------------------- sites
-- Global cities. The 44 seeded Kenyan branches are left untouched.
insert into public.sites (name, slug, region, criticality, voice_aliases, extension, primary_ip)
values
  ('Nairobi HQ',  'nairobi-hq', 'Africa',      'critical', array['nairobi','nairobi hq','headquarters','hq'],      '100', '192.168.10.10'),
  ('Lagos',       'lagos',      'Africa',      'standard', array['lagos','lagos branch','nigeria'],                '101', '192.168.10.11'),
  ('Dubai',       'dubai',      'Middle East', 'standard', array['dubai','dubai branch','uae','emirates'],          '102', '192.168.10.12'),
  ('London',      'london',     'Europe',      'standard', array['london','london branch','uk'],                   '103', '192.168.10.13'),
  ('Singapore',   'singapore',  'APAC',        'standard', array['singapore','singapore branch','sg'],             '104', '192.168.10.14'),
  ('Sao Paulo',   'sao-paulo',  'LATAM',       'standard', array['sao paulo','san paulo','brazil','sao paolo'],     '105', '192.168.10.15'),
  ('New York',    'new-york',   'Americas',    'critical', array['new york','new york branch','nyc','manhattan'],   '106', '192.168.10.16')
on conflict (slug) do update
  set name          = excluded.name,
      region        = excluded.region,
      criticality   = excluded.criticality,
      voice_aliases = excluded.voice_aliases;

-- ------------------------------------------------------------ site_access
-- it_manager on all 7 demo sites. Without this every dispatch is denied by
-- evaluateCommandPolicy() and the voice agent silently 403s on stage.
-- Grants to EVERY confirmed user, so it works no matter which email you
-- used when creating the account in the dashboard.
insert into public.site_access (operator_id, site_id, role)
select u.id, s.id, 'it_manager'
from auth.users u
cross join public.sites s
where u.email_confirmed_at is not null
  and s.slug in ('nairobi-hq','lagos','dubai','london','singapore','sao-paulo','new-york')
on conflict (operator_id, site_id) do update set role = excluded.role;

-- ------------------------------------------------------------ verification
-- Do not trust "the SQL ran fine" — check the counts that actually matter.
select
  (select count(*) from auth.users where email_confirmed_at is not null) as confirmed_users,
  (select count(*) from public.sites where slug in
     ('nairobi-hq','lagos','dubai','london','singapore','sao-paulo','new-york')) as demo_sites,
  (select count(*) from public.site_access) as access_grants;
-- Expect: confirmed_users >= 1, demo_sites = 7, access_grants >= 7.
-- If access_grants is 0, the operator account was not created yet — go back
-- to the PREREQUISITE above.
