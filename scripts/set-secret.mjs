#!/usr/bin/env node
/**
 * Sets one secret in one .env file, reading the value from stdin.
 *
 * Exists so no secret ever has to be typed onto a command line, where it
 * would be visible in the process list and kept in shell history. The
 * counterpart for Supabase keys is configure-project.mjs, which fetches them
 * rather than being handed them; this is for the ones only you have.
 *
 * Usage:
 *   node scripts/set-secret.mjs ELEVENLABS_API_KEY apps/control-plane/.env
 *   <paste the value, press Enter>
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const [name, path] = process.argv.slice(2);
if (!name || !path) {
  console.error("Usage: node scripts/set-secret.mjs <VAR_NAME> <path/to/.env>");
  process.exit(1);
}
if (!/^[A-Z0-9_]+$/.test(name)) {
  console.error("Variable names are upper snake case.");
  process.exit(1);
}
if (!existsSync(path)) {
  console.error(`${path} does not exist. Copy the matching .env.example first.`);
  process.exit(1);
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log(`Paste the value for ${name}, then Enter:`);

rl.once("line", (raw) => {
  const value = raw.trim();
  rl.close();
  if (!value) {
    console.error("\nNothing pasted. Aborted, file unchanged.");
    process.exit(1);
  }

  const original = readFileSync(path, "utf-8");
  const line = `${name}=${value}`;
  const re = new RegExp(`^${name}=.*$`, "m");
  writeFileSync(path, re.test(original) ? original.replace(re, line) : `${original.replace(/\n*$/, "\n")}${line}\n`);

  // The length is a useful sanity check (a truncated paste is a common and
  // otherwise invisible mistake) and reveals nothing about the value.
  console.log(`\n  ok ${path} <- ${name}  (${value.length} characters)`);
  console.log("  Not printed, not in your shell history.");
});
