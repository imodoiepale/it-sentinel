#!/usr/bin/env node
/**
 * Pushes the secrets from your local .env files up to the Render services.
 *
 * Reads the values off disk and PUTs them straight to Render's API. Nothing
 * is printed, nothing is passed as a command-line argument (argv is visible
 * in the process list and lands in shell history), and the Render API key is
 * read from stdin for the same reason.
 *
 * Run it after scripts/configure-project.mjs has filled the .env files in,
 * and again any time RELAY_PUBLIC_URL changes — which it does every time you
 * move to a different network, because it has to carry the command laptop's
 * LAN address.
 *
 * Usage:
 *   node scripts/configure-render.mjs
 *   <paste your rnd_... API key, press Enter>
 */

import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const CONTROL_PLANE = "it-sentinel-control-plane";
const WEB = "it-sentinel-web";

/**
 * The deployed control plane's public URL.
 *
 * NOT taken from apps/web/.env.local: that file holds http://localhost:8787
 * for local development, and pushing localhost into the deployed console is
 * how you ship a dashboard whose every API call fails in the browser with no
 * server-side error to find. Production URLs belong here, secrets come from
 * the .env files, and the two are deliberately different sources.
 */
const CONTROL_PLANE_PUBLIC_URL = "https://it-sentinel-control-plane.onrender.com";

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim();
  }
  return out;
}

const cp = readEnv("apps/control-plane/.env");
const web = readEnv("apps/web/.env.local");

/**
 * Explicit per-service lists rather than "copy everything". The service_role
 * key bypasses RLS entirely, so which service receives it is a security
 * decision that should be readable here at a glance — and the web service
 * must never get one, because a NEXT_PUBLIC_* variable is shipped to every
 * browser that loads the console.
 */
const PLAN = [
  {
    service: CONTROL_PLANE,
    vars: {
      SUPABASE_URL: cp.SUPABASE_URL,
      SUPABASE_SERVICE_ROLE_KEY: cp.SUPABASE_SERVICE_ROLE_KEY,
      SUPABASE_PUBLISHABLE_KEY: cp.SUPABASE_PUBLISHABLE_KEY,
      VOICE_WEBHOOK_SECRET: cp.VOICE_WEBHOOK_SECRET,
      ELEVENLABS_API_KEY: cp.ELEVENLABS_API_KEY,
      ELEVENLABS_VOICE_ID: cp.ELEVENLABS_VOICE_ID,
      RELAY_PUBLIC_URL: cp.RELAY_PUBLIC_URL,
      PORT: "8787",
      NODE_VERSION: "22",
    },
  },
  {
    service: WEB,
    vars: {
      NEXT_PUBLIC_SUPABASE_URL: web.NEXT_PUBLIC_SUPABASE_URL,
      NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY: web.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY,
      NEXT_PUBLIC_CONTROL_PLANE_URL: CONTROL_PLANE_PUBLIC_URL,
      // The console talks to the ElevenLabs agent directly from the browser
      // via their SDK, so there is no server-side agent URL to set. The old
      // NEXT_PUBLIC_SENTINEL_AGENT_URL pointed at the control plane, which
      // has no /v1/ask route — every submission 404'd until the Ask box was
      // removed. Deleted rather than left set: an env var nothing reads is a
      // trap for whoever next tries to work out what talks to what.
      NEXT_PUBLIC_ELEVENLABS_AGENT_ID: "agent_8001m15d76mafg9rgjkpyfxwm1z6",
      NODE_VERSION: "22",
    },
  },
];

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log("Paste your Render API key (rnd_...), then Enter:");

rl.once("line", async (raw) => {
  const key = raw.trim();
  rl.close();
  if (!key.startsWith("rnd_")) {
    console.error("\nThat does not look like a Render API key (expected rnd_...). Aborted.");
    process.exit(1);
  }
  const auth = { Authorization: `Bearer ${key}`, "Content-Type": "application/json" };

  const res = await fetch("https://api.render.com/v1/services?limit=100", { headers: auth });
  if (!res.ok) {
    console.error(`\nRender API returned ${res.status}. Check the key.`);
    process.exit(1);
  }
  const services = (await res.json()).map((s) => s.service ?? s);

  let failed = false;
  for (const { service, vars } of PLAN) {
    const svc = services.find((s) => s.name === service);
    if (!svc) {
      console.error(`  x ${service} not found on this account`);
      failed = true;
      continue;
    }

    const present = Object.entries(vars).filter(([, v]) => v);
    const missing = Object.entries(vars)
      .filter(([, v]) => !v)
      .map(([k]) => k);

    // PUT replaces the whole set, so anything not sent is deleted. Sending
    // only the keys we actually have would silently wipe values set by hand
    // in the dashboard, so missing ones are reported and the rest still go.
    const body = present.map(([key, value]) => ({ key, value }));
    const put = await fetch(`https://api.render.com/v1/services/${svc.id}/env-vars`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify(body),
    });

    if (!put.ok) {
      console.error(`  x ${service}: ${put.status} ${(await put.text()).slice(0, 120)}`);
      failed = true;
      continue;
    }
    console.log(`  ok ${service} <- ${present.map(([k]) => k).join(", ")}`);
    if (missing.length) console.log(`     (blank locally, not sent: ${missing.join(", ")})`);
  }

  console.log("\nNothing was printed and nothing entered your shell history.");
  console.log("Render redeploys automatically when env vars change.");
  process.exit(failed ? 1 : 0);
});
