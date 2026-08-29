#!/usr/bin/env node
/**
 * Creates (or removes) a throwaway operator account for smoke-testing the
 * console, using Supabase's Auth Admin API.
 *
 * Exists because the interesting failures are all behind the login: useFleet,
 * the realtime subscription, AlertAnnouncer and ActivityFeed only mount once
 * a session exists, so "the login page renders" proves almost nothing. This
 * gives a disposable account to check the real screen with, without anyone
 * having to hand over their own password.
 *
 * The Admin API is used rather than an INSERT into auth.users: GoTrue's
 * internal columns differ between versions, and hand-writing a bcrypt hash
 * into someone's auth schema is a good way to create an account that exists
 * but cannot log in.
 *
 * Usage:
 *   node scripts/temp-operator.mjs create
 *   node scripts/temp-operator.mjs delete
 */

import { readFileSync, existsSync } from "node:fs";

const EMAIL = "smoke-test@it-sentinel.local";
const PASSWORD = "SmokeTest-Temporary-2026";

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim();
  }
  return out;
}

const env = readEnv("apps/control-plane/.env");
const URL = env.SUPABASE_URL;
const KEY = env.SUPABASE_SERVICE_ROLE_KEY;
if (!URL || !KEY) {
  console.error("SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY missing from apps/control-plane/.env");
  process.exit(1);
}
const headers = { apikey: KEY, Authorization: `Bearer ${KEY}`, "content-type": "application/json" };

async function findUser() {
  const res = await fetch(`${URL}/auth/v1/admin/users?per_page=200`, { headers });
  if (!res.ok) throw new Error(`admin list failed: ${res.status}`);
  return ((await res.json()).users ?? []).find((u) => u.email === EMAIL) ?? null;
}

const action = process.argv[2];

if (action === "create") {
  let user = await findUser();
  if (!user) {
    const res = await fetch(`${URL}/auth/v1/admin/users`, {
      method: "POST",
      headers,
      body: JSON.stringify({ email: EMAIL, password: PASSWORD, email_confirm: true }),
    });
    if (!res.ok) {
      console.error(`create failed: ${res.status} ${(await res.text()).slice(0, 200)}`);
      process.exit(1);
    }
    user = await res.json();
  }

  // Without a site_access grant RLS shows this operator nothing at all, and
  // the console renders an empty fleet that looks identical to a broken one —
  // which would make the smoke test worse than useless.
  const grants = await fetch(`${URL}/rest/v1/rpc/grant_smoke_access`, { method: "POST", headers }).catch(() => null);
  if (!grants || !grants.ok) {
    const sites = await (await fetch(`${URL}/rest/v1/sites?select=id`, { headers })).json();
    await fetch(`${URL}/rest/v1/site_access`, {
      method: "POST",
      headers: { ...headers, Prefer: "resolution=merge-duplicates" },
      body: JSON.stringify(sites.map((s) => ({ operator_id: user.id, site_id: s.id, role: "it_manager" }))),
    });
  }

  console.log(`email:    ${EMAIL}`);
  console.log(`password: ${PASSWORD}`);
  console.log(`id:       ${user.id}`);
  console.log("\nTemporary. Remove it with: node scripts/temp-operator.mjs delete");
} else if (action === "delete") {
  const user = await findUser();
  if (!user) {
    console.log("nothing to delete");
    process.exit(0);
  }
  const res = await fetch(`${URL}/auth/v1/admin/users/${user.id}`, { method: "DELETE", headers });
  console.log(res.ok ? `deleted ${EMAIL}` : `delete failed: ${res.status}`);
} else {
  console.error("Usage: node scripts/temp-operator.mjs create|delete");
  process.exit(1);
}
