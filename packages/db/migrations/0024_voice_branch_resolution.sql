-- Voice "open <branch>" resolution: trigram similarity over sites.name and
-- voice_aliases (seeded in 001_sites.sql specifically to disambiguate
-- Sarit Centre/Annex/City Brands-Sarit, Nyali A/B/Bazaar, Runda Main/
-- Perfume, Westend/Perfume, Junction Mall/Store). SECURITY INVOKER (the
-- default) deliberately — this runs as the calling operator, so RLS on
-- sites still applies and a branch outside their site_access never
-- resolves, matching the plan's "out-of-scope site rejected at every tier".

create or replace function public.resolve_branch_by_voice(p_query text, p_limit int default 3)
returns table (site_id uuid, name text, slug text, similarity real)
language sql
stable
set search_path = public, pg_catalog
as $$
  select
    s.id as site_id,
    s.name,
    s.slug,
    greatest(
      similarity(s.name, p_query),
      coalesce((select max(similarity(alias, lower(p_query))) from unnest(s.voice_aliases) as alias), 0)
    ) as similarity
  from public.sites s
  where s.name % p_query
     or exists (select 1 from unnest(s.voice_aliases) as alias where alias % lower(p_query))
  order by similarity desc
  limit p_limit;
$$;

-- Readable by any authenticated operator; RLS on the underlying sites table
-- (has_site_access) is what actually constrains results, not this grant.
revoke all on function public.resolve_branch_by_voice(text, int) from public, anon;
grant execute on function public.resolve_branch_by_voice(text, int) to authenticated;
