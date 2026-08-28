import { readFileSync, writeFileSync } from "node:fs";

const csv = readFileSync(new URL("./branches.csv", import.meta.url), "utf8");
const [header, ...lines] = csv.trim().split("\n");
const rows = lines.map((line) => {
  const [name, extension, ip, region] = line.split(",");
  return { name: name.trim(), extension: extension?.trim() || null, ip: ip?.trim() || null, region: region?.trim() || "Nairobi" };
});

const slugify = (s) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");

// Extra voice aliases for names that are easy to mis-hear or that collide
// with a sibling branch — these are exercised directly by the voice
// resolution test suite in the plan's Verification section.
const EXTRA_ALIASES = {
  "sarit-centre": ["sarit", "sarit main"],
  "sarit-centre-annex": ["sarit annex", "sarit second"],
  "city-brands-sarit": ["city brands sarit", "citybrands sarit"],
  "nyali-a": ["nyali a", "nyali one"],
  "nyali-b": ["nyali b", "nyali two"],
  "nyali-bazaar": ["nyali bazaar"],
  "runda-main": ["runda", "runda main"],
  "runda-perfume": ["runda perfume", "runda scent"],
  "westend": ["west end", "westlands end"],
  "westend-perfume": ["westend perfume", "west end perfume"],
  "junction-mall": ["junction", "junction mall"],
  "junction-store": ["junction store"],
};

const escSql = (v) => (v === null ? "NULL" : `'${String(v).replace(/'/g, "''")}'`);

const values = rows
  .map((r) => {
    const slug = slugify(r.name);
    const aliases = new Set([r.name.toLowerCase(), ...(EXTRA_ALIASES[slug] ?? [])]);
    const aliasArray = `ARRAY[${[...aliases].map((a) => escSql(a)).join(", ")}]::text[]`;
    const criticality = r.name.includes("Server") || r.name === "HQ Server" ? "'critical'" : "'standard'";
    return `  (${escSql(r.name)}, ${escSql(slug)}, ${escSql(r.extension)}, ${r.ip ? escSql(r.ip) : "NULL"}, ${escSql(r.region)}, ${criticality}, ${aliasArray})`;
  })
  .join(",\n");

const sql = `-- Auto-generated from branches.csv by generate-seed.mjs. Do not hand-edit; regenerate instead.
insert into public.sites (name, slug, extension, primary_ip, region, criticality, voice_aliases)
values
${values}
on conflict (slug) do update set
  extension = excluded.extension,
  primary_ip = excluded.primary_ip,
  region = excluded.region,
  voice_aliases = excluded.voice_aliases;
`;

writeFileSync(new URL("./001_sites.sql", import.meta.url), sql);
console.log(`Generated seed for ${rows.length} sites.`);
