#!/usr/bin/env node
/**
 * Points every local .env at one Supabase project and fills in its keys.
 *
 * The keys are fetched from the Supabase Management API at run time and
 * written straight to disk. They are never printed, never passed as a
 * command-line argument (argv is visible in the process list and lands in
 * shell history), and never echoed back — the script reports only which
 * variable it set in which file.
 *
 * The personal access token is read from stdin for the same reason.
 * Create one at https://supabase.com/dashboard/account/tokens
 *
 * Usage:
 *   node scripts/configure-project.mjs <project-ref>
 *   <paste your sbp_... token, press Enter>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const ref = process.argv[2];
if (!ref || !/^[a-z]{20}$/.test(ref)) {
  console.error("Usage: node scripts/configure-project.mjs <project-ref>");
  console.error("  e.g. node scripts/configure-project.mjs ncyerayycwkqytznnkrs");
  process.exit(1);
}

const SUPABASE_URL = `https://${ref}.supabase.co`;

/**
 * Which variable goes in which file. Deliberately explicit rather than
 * pattern-matched: the service_role key bypasses RLS entirely, so which
 * files receive it is a security decision that should be readable at a
 * glance. The web app gets ONLY the publishable key — a service_role key in
 * a NEXT_PUBLIC_* variable would be shipped to every browser.
 */
const TARGETS = [
  { path: "apps/control-plane/.env", vars: { SUPABASE_URL: "url", SUPABASE_SERVICE_ROLE_KEY: "service", SUPABASE_PUBLISHABLE_KEY: "anon" } },
  { path: "apps/relay/.env", vars: { SUPABASE_URL: "url", SUPABASE_SERVICE_ROLE_KEY: "service" } },
  { path: "apps/sentinel-agent/.env", vars: { SUPABASE_URL: "url", SUPABASE_PUBLISHABLE_KEY: "anon" } },
  { path: "apps/web/.env.local", vars: { NEXT_PUBLIC_SUPABASE_URL: "url", NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: "anon" } },
];

function setVar(path, name, value) {
  const original = existsSync(path) ? readFileSync(path, "utf-8") : "";
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  const updated = re.test(original) ? original.replace(re, line) : `${original.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(path, updated);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log(`Configuring for project ${ref}.`);
console.log("Paste your Supabase personal access token (sbp_...), then Enter:");

rl.once("line", async (raw) => {
  const pat = raw.trim();
  rl.close();

  if (!pat.startsWith("sbp_")) {
    console.error("\nThat does not look like a personal access token (expected sbp_...). Aborted.");
    process.exit(1);
  }

  const res = await fetch(`https://api.supabase.com/v1/projects/${ref}/api-keys`, {
    headers: { Authorization: `Bearer ${pat}` },
  }).catch((err) => {
    console.error(`\nCould not reach the Supabase API: ${err.message}`);
    process.exit(1);
  });

  if (!res.ok) {
    // 401 means a bad or expired token; 404 means the token is valid but has
    // no access to this ref — worth distinguishing, they have different fixes.
    console.error(`\nAPI returned ${res.status}. ${res.status === 404 ? "Check the project ref, and that this token's account owns it." : "Check the token."}`);
    process.exit(1);
  }

  const keys = await res.json();
  const find = (name) => keys.find((k) => k.name === name && k.api_key)?.api_key;
  const anon = find("anon");
  const service = find("service_role");

  if (!anon || !service) {
    console.error("\nThe API did not return both an anon and a service_role key. Aborted; nothing was written.");
    process.exit(1);
  }

  const values = { url: SUPABASE_URL, anon, service };
  console.log("");
  for (const target of TARGETS) {
    if (!existsSync(target.path)) {
      console.log(`  - ${target.path} (skipped, does not exist)`);
      continue;
    }
    for (const [name, kind] of Object.entries(target.vars)) setVar(target.path, name, values[kind]);
    console.log(`  ok ${target.path} -> ${Object.keys(target.vars).join(", ")}`);
  }

  console.log(`\nDone. Nothing was printed to the screen and nothing entered your shell history.`);
  console.log(`These .env files are gitignored. The service_role key bypasses RLS — treat it like a database password.`);
});
