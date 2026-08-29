#!/usr/bin/env node
/**
 * Creates (or updates) the Sentinel Global conversational agent in
 * ElevenLabs, with every webhook tool wired to the deployed control plane.
 *
 * Doing this through the API rather than by hand in the dashboard is not
 * about saving clicks: twelve tools each need a URL, a header, a JSON schema
 * and a description written to make the model pick the right one, and a
 * single mistyped path fails only when someone says that one sentence on
 * stage. Defining them here means the config is reviewable, diffable, and
 * reproducible if the agent has to be rebuilt.
 *
 * The system prompt is read from docs/16-elevenlabs-agent-config.md, so the
 * documentation and the live agent cannot drift apart.
 *
 * Secrets are read from apps/control-plane/.env and from stdin — never argv.
 *
 * Usage:
 *   node scripts/create-elevenlabs-agent.mjs [--url https://your-control-plane]
 *   <paste your ElevenLabs API key (sk_...), press Enter>
 */

import { readFileSync, existsSync } from "node:fs";
import { createInterface } from "node:readline";

const DEFAULT_URL = "https://it-sentinel-control-plane.onrender.com";
const urlFlag = process.argv.indexOf("--url");
const BASE = (urlFlag > -1 ? process.argv[urlFlag + 1] : DEFAULT_URL).replace(/\/+$/, "");
const AGENT_NAME = "IT Sentinel — Global Command";

function readEnv(path) {
  if (!existsSync(path)) return {};
  const out = {};
  for (const line of readFileSync(path, "utf-8").split("\n")) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m && m[2].trim()) out[m[1]] = m[2].trim();
  }
  return out;
}

const cpEnv = readEnv("apps/control-plane/.env");
const VOICE_SECRET = cpEnv.VOICE_WEBHOOK_SECRET;
if (!VOICE_SECRET) {
  console.error("VOICE_WEBHOOK_SECRET is not set in apps/control-plane/.env — the tools would all 401.");
  process.exit(1);
}

/** The system prompt lives in the docs so the two cannot drift. */
function systemPrompt() {
  // Normalise line endings before matching. The repo checks out CRLF on
  // Windows, so a \n in the pattern silently matches nothing and the script
  // reports "prompt not found" on a file that plainly contains it.
  const doc = readFileSync("docs/16-elevenlabs-agent-config.md", "utf-8").replace(/\r\n/g, "\n");
  const m = doc.match(/```text\n([\s\S]*?)\n```/);
  if (!m) {
    console.error("Could not find the system prompt block in docs/16-elevenlabs-agent-config.md.");
    process.exit(1);
  }
  return m[1];
}

const str = (description) => ({ type: "string", description });

/**
 * Descriptions are written to make the model choose correctly, not to restate
 * the path — that is the actual engineering in this file. The distinction
 * between get_branch_status ("what's wrong there") and get_machine_detail
 * ("how are the printers") is carried entirely by this wording, as is the
 * rule that check_status is the only way to learn an outcome.
 */
const TOOLS = [
  ["get_fleet_status", "/v1/voice/fleet",
   "Summarise the whole fleet: how many machines, how many critical, warning or offline. Use for 'how is the fleet', 'is everything ok', 'give me a status'. Takes no parameters.", {}],
  ["get_branch_status", "/v1/voice/branch",
   "Report what is currently wrong at ONE branch. Use for a vague problem report — 'something's wrong in Lagos', 'check on Dubai', 'what's wrong there'. For a specific subsystem use get_machine_detail instead.",
   { branch: str("The branch name as the operator said it, e.g. Lagos, Dubai, Sao Paulo.") }, ["branch"]],
  ["get_machine_detail", "/v1/voice/detail",
   "The detail behind a fault at one branch, for ONE named subsystem. Use when the operator names an area: 'how are the printers in Dubai', 'what does disk look like', 'is Enquest up', 'is security clean'. Returns real numbers from the latest heartbeat, and says so if that heartbeat is stale.",
   { branch: str("The branch name."), topic: { type: "string", enum: ["printer", "network", "disk", "services", "security", "enquest", "all"], description: "Which subsystem the operator asked about. Use 'all' only if they did not name one." } }, ["branch"]],
  ["describe_capabilities", "/v1/voice/capabilities",
   "Describe what you can do, computed live from the server's registries. Use whenever the operator asks what you can do, what you handle, or what you are for. Always call this instead of reciting a list from memory — your memory of the tools goes stale the moment one is added. Takes no parameters.", {}],
  ["list_playbooks", "/v1/voice/playbooks",
   "List the remediation playbooks that can actually be run. Use for 'what can you fix', 'what playbooks do I have'. Takes no parameters.", {}],
  ["run_playbook", "/v1/voice/remediate",
   "Dispatch a hash-pinned remediation playbook to a branch. This SENDS the command; it does NOT tell you it worked — call check_status afterwards for the outcome. Pass the keyword from list_playbooks or describe_capabilities, not the friendly label.",
   { branch: str("The branch name."), action: str("The playbook keyword, e.g. spooler, print queue, test print, dns, gateway, health, security, enquest.") }, ["branch", "action"]],
  ["control_service", "/v1/voice/service",
   "Start, stop or restart a Windows service on a branch's machines. This SENDS the command; call check_status for the outcome. The service must be one of the allowlisted ids.",
   { branch: str("The branch name."), service: { type: "string", enum: ["spooler", "dns", "dhcp", "time", "defender", "workstation", "netlogon", "update", "enquest"], description: "Allowlisted service id — not a raw Windows service name." }, action: { type: "string", enum: ["start", "stop", "restart"], description: "What to do to the service." } }, ["branch", "service", "action"]],
  ["check_status", "/v1/voice/status",
   "Report how recently dispatched commands actually turned out. This is the ONLY way to learn whether something worked. Call it whenever the operator asks 'did that work', 'is it fixed', 'is it back', even if you dispatched seconds ago.",
   { branch: str("Branch name, or omit for the whole fleet.") }],
  ["get_recurrence", "/v1/voice/recurrence",
   "Say whether a fault has been seen before anywhere in the fleet, at which branches, and what fix worked last time. Use for 'has this happened before', 'is this the usual thing', 'what fixed it last time'.",
   { branch: str("The branch name."), checkType: str("Optional: enquest, security or printer. Omit to use the branch's newest open alert.") }, ["branch"]],
  ["open_machine", "/v1/voice/open",
   "Put a branch machine's live screen on the operator's console via remote desktop. Use for 'open Lagos', 'show me that machine', 'let me see it'.",
   { branch: str("The branch name.") }, ["branch"]],
  ["launch_app", "/v1/voice/launch",
   "Launch an allowlisted application on a branch machine, e.g. Chrome, Notepad, the Camera app. Use for 'open Chrome on Lagos'.",
   { branch: str("The branch name."), app: { type: "string", enum: ["notepad", "calculator", "explorer", "chrome", "edge", "camera", "taskmanager", "eventviewer", "services", "control"], description: "Allowlisted application id." } }, ["branch", "app"]],
  ["open_all_cameras", "/v1/voice/cameras",
   "Open the camera on every machine, at one branch or across the whole fleet. Use for 'open all cameras', 'show me the cameras'.",
   { branch: str("A branch name, or 'all' for every branch.") }],
  ["retire_machine", "/v1/voice/retire",
   "Take a machine off the roster. DESTRUCTIVE and two-step: call it first WITHOUT confirm to hear what will happen, read that back, and only call again with confirm true after the operator explicitly agrees. Never set confirm on the first call.",
   { branch: str("The branch name."), hostname: str("Optional hostname or fragment, required when the branch has more than one machine."), confirm: { type: "boolean", description: "Only true after the operator has explicitly confirmed out loud." } }, ["branch"]],
];

function toolDefinition([name, path, description, properties, required = []]) {
  return {
    type: "webhook",
    name,
    description,
    api_schema: {
      url: `${BASE}${path}`,
      method: "POST",
      request_headers: { "x-sentinel-voice-key": VOICE_SECRET, "content-type": "application/json" },
      request_body_schema: {
        type: "object",
        description: `Request body for ${name}.`,
        properties,
        required,
      },
    },
  };
}

const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: false });
console.log(`Creating "${AGENT_NAME}" with tools pointed at ${BASE}`);
console.log("Paste your ElevenLabs API key (sk_...), then Enter:");

rl.once("line", async (raw) => {
  const apiKey = raw.trim();
  rl.close();
  if (!apiKey.startsWith("sk_")) {
    console.error("\nThat does not look like an ElevenLabs key (expected sk_...). Aborted.");
    process.exit(1);
  }
  const headers = { "xi-api-key": apiKey, "content-type": "application/json" };

  const body = {
    name: AGENT_NAME,
    conversation_config: {
      agent: {
        prompt: {
          prompt: systemPrompt(),
          llm: "gpt-4o-mini",
          temperature: 0.1, // low: this agent reads server text back, it does not compose
          tools: TOOLS.map(toolDefinition),
        },
        first_message:
          "Sentinel Global command center. Seven branches on the board. What do you need?",
        language: "en",
      },
    },
  };

  // Reuse the existing agent if one is already named this, so re-running does
  // not litter the account with duplicates that all answer to the same name.
  const listRes = await fetch("https://api.elevenlabs.io/v1/convai/agents?page_size=100", { headers });
  const existing = listRes.ok
    ? ((await listRes.json()).agents ?? []).find((a) => a.name === AGENT_NAME)
    : null;

  const res = existing
    ? await fetch(`https://api.elevenlabs.io/v1/convai/agents/${existing.agent_id}`, {
        method: "PATCH",
        headers,
        body: JSON.stringify(body),
      })
    : await fetch("https://api.elevenlabs.io/v1/convai/agents/create", {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });

  if (!res.ok) {
    console.error(`\nElevenLabs returned ${res.status}:`);
    console.error((await res.text()).slice(0, 900));
    process.exit(1);
  }

  const out = await res.json();
  const id = out.agent_id ?? existing?.agent_id;
  console.log(`\n  ${existing ? "updated" : "created"}: ${AGENT_NAME}`);
  console.log(`  agent_id: ${id}`);
  console.log(`  tools:    ${TOOLS.length}`);
  console.log(`  endpoint: ${BASE}`);
  console.log(`\n  Test it: https://elevenlabs.io/app/conversational-ai/agents/${id}`);
  console.log("  Pick a voice in the dashboard, then say: \"What can you do?\"");
});
