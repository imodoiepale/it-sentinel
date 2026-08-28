#!/usr/bin/env node
/**
 * Writes the Supabase service_role key into the two .env files that need it.
 *
 * The key is read from stdin rather than an argv parameter on purpose: a
 * command-line argument lands in your shell history and is visible to any
 * other process on the machine via the process list, and this particular
 * secret bypasses RLS entirely — it is equivalent to a database superuser.
 *
 * Usage (the key is not echoed):
 *   node scripts/set-service-role-key.mjs
 *   <paste the key, press Enter>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const TARGETS = ["apps/control-plane/.env", "apps/relay/.env"];
const VAR = "SUPABASE_SERVICE_ROLE_KEY";

function setVar(path, name, value) {
  if (!existsSync(path)) {
    console.error(`  ✗ ${path} does not exist — create it from the .env.example first`);
    return false;
  }
  const original = readFileSync(path, "utf-8");
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  const updated = re.test(original) ? original.replace(re, line) : `${original.replace(/\n*$/, "\n")}${line}\n`;
  writeFileSync(path, updated);
  return true;
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log("Paste the service_role key (Supabase Dashboard -> Project Settings -> API Keys), then Enter:");

rl.once("line", (raw) => {
  const key = raw.trim();
  rl.close();

  // Shape check before writing. The most common mistake here is pasting the
  // sbp_ personal access token or the sb_publishable_ key instead — both are
  // the wrong credential, and the resulting failure ("permission denied for
  // table") surfaces much later and looks like a schema problem.
  if (!key) {
    console.error("\n✗ Nothing pasted. Aborted, files unchanged.");
    process.exit(1);
  }
  if (key.startsWith("sbp_")) {
    console.error("\n✗ That is a personal access token, not the service_role key. Aborted.");
    process.exit(1);
  }
  if (key.startsWith("sb_publishable_")) {
    console.error("\n✗ That is the publishable key, not the service_role key. Aborted.");
    process.exit(1);
  }
  if (!key.startsWith("eyJ")) {
    console.error("\n✗ Expected a JWT starting with 'eyJ'. Aborted, files unchanged.");
    process.exit(1);
  }

  console.log("");
  let ok = true;
  for (const t of TARGETS) {
    if (setVar(t, VAR, key)) console.log(`  ✓ ${t}`);
    else ok = false;
  }

  console.log(ok ? "\nDone. The key was not printed and is not in your shell history." : "\nFinished with errors.");
  process.exit(ok ? 0 : 1);
});
