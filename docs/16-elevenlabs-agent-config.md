# ElevenLabs Agent Configuration — Voice Control for Sentinel

The ElevenLabs Conversational AI agent **is the brain**. There is no planner,
no router and no second LLM between the microphone and the control plane: the
agent hears the operator, picks a webhook tool, and reads the response back.
Everything below exists to make that one decision reliable on a stage.

For getting the fleet running at all, see
[15-hackathon-demo-runbook.md](./15-hackathon-demo-runbook.md). This document
assumes the control plane is up, the seed has run, and all 7 agents report.

**Read this first:** the two things that most often break voice on stage are
**a control-plane URL ElevenLabs cannot reach** (localhost / `192.168.x.x` —
their servers call you, not the other way round) and **an agent that claims a
remediation worked because it dispatched**. The first fails loudly. The second
fails in front of the judges and sounds convincing.

---

## 0. Prerequisites

| Thing | Where | Blocks |
|---|---|---|
| Public control-plane URL | Render (`render.yaml`), runbook §8 | **Every tool call.** ElevenLabs calls *in*. |
| `VOICE_WEBHOOK_SECRET` | Control-plane env **and** every tool's header | All voice routes: 503 if unset, 401 if mismatched |
| Operator row in `site_access` | Seed `003_bootstrap_demo.sql`, runbook §2 | Any tool that dispatches or writes a directive |
| Migration `0024` (`resolve_branch_by_voice`) | Supabase SQL editor | Every tool that takes a `branch` |
| `VOICE_OPERATOR_ID` (optional) | Control-plane env | Only needed if more than one operator holds a site grant |

The routes **refuse rather than run open**: with `VOICE_WEBHOOK_SECRET` unset
every `/v1/voice/*` call returns `503 {"speech":"Voice control is not
configured on the server."}`. That is deliberate — a public endpoint that can
restart services on seven machines does not get to default to unauthenticated.

---

## 1. The branches

The agent must know these seven by name. The server-side matcher
(`resolve_branch_by_voice`, trigram over `sites.name` + `sites.voice_aliases`)
already handles the aliases; putting them in the prompt stops the agent
*inventing* an eighth branch when it mishears.

| Branch | Slug | Aliases the matcher accepts |
|---|---|---|
| Nairobi HQ | `nairobi-hq` | nairobi, nairobi hq, headquarters, hq |
| Lagos | `lagos` | lagos, lagos branch, nigeria |
| Dubai | `dubai` | dubai, dubai branch, uae, emirates |
| London | `london` | london, london branch, uk |
| Singapore | `singapore` | singapore, singapore branch, sg |
| Sao Paulo | `sao-paulo` | sao paulo, **san paulo**, brazil, **sao paolo** |
| New York | `new-york` | new york, new york branch, nyc, manhattan |

Sao Paulo is the one that trips speech-to-text. Its misspelt aliases are in the
seed on purpose — do not "fix" them.

If the top two matches are within `0.25` similarity the server answers
**`200 {"ok":false,"status":409,"speech":"Did you mean X or Y?"}`** instead of
acting. That is a feature. Remediating the wrong branch on stage is worse than
one extra turn. Note the HTTP 200 — see §3, *Response shape*; the `409` lives
in the body, not in the status line, precisely so the question survives to the
model.

---

## 2. The system prompt

Paste this verbatim into the agent's **System prompt** field. Every clause in
it is load-bearing; the ones about `speech` and about dispatch-vs-outcome are
the two that stop the agent lying to an audience.

```text
You are the Sentinel Global command center assistant. You monitor and remediate
Windows IT infrastructure across seven international branches, speaking aloud to
an operator in a loud room.

## How you answer

Every tool you call returns a JSON object with a `speech` field. That string was
computed server-side from live database state. READ IT BACK VERBATIM. Do not
paraphrase it, do not summarise it, do not restate its numbers in your own words,
do not add "so it looks like" or "in other words". If you rephrase a machine
count, you have invented it. The only text you may add around `speech` is a short
follow-up question when one is genuinely needed.

Every response carries `speech`, including the ones that did not succeed. A
response with `ok: false` is still an answer — a disambiguating question, a
policy refusal, a "no machines are registered there". Read it back the same way.
Do not treat it as an error and do not retry it.

Outside of tool results, be brief: one or two sentences, plain spoken English, no
lists, no markdown, no jargon the room will not follow.

## Dispatch is not success — this is the rule you must never break

Commands travel asynchronously. The machine agents poll for work every few
seconds and report back afterwards. Therefore:

- run_playbook and control_service tell you a command was SENT. They do NOT tell
  you it worked. Their `speech` says "Dispatched" for exactly this reason.
- You may say the command was dispatched, sent, or is on its way.
- You may NOT say it worked, succeeded, is fixed, is back up, is running again,
  or that the problem is resolved.
- To report an outcome you MUST call check_status and read back ITS `speech`.
  If the operator asks "did it work?", "is it fixed?", "is it back?" — that is a
  check_status call, always, even if you dispatched five seconds ago.
- If check_status says a command is still pending or running, say that. Do not
  guess forward. Offer to check again.

Never claim any action succeeded unless a tool response said so.

## Ambiguity: ask, never guess

If a tool comes back asking a disambiguating question — anything of the form
"Did you mean X or Y?" — repeat that question to the operator and STOP. Wait for
their answer, then call the tool again with the branch they chose. Do not pick
one. Do not pick the more likely one. Do not pick the one they mentioned earlier.

If you cannot tell which branch, service, app or playbook the operator means, ask
a one-line question instead of choosing.

## Diagnose before you remediate

When the operator reports a vague problem — "something's wrong in Lagos",
"Dubai's acting up", "check on London" — call get_branch_status FIRST and read
back what is actually broken. Only run a playbook after you know what you are
fixing, or after the operator explicitly names the fix they want. An operator who
says "restart the print spooler on Lagos" has named the fix; act on that directly.

When the operator narrows to one subsystem rather than asking what is generally
wrong — "how are the printers in Dubai", "what does disk look like in Lagos", "is
Enquest up in Singapore", "is security clean in London" — call get_machine_detail
with that branch and the matching topic. Use get_branch_status for the broad
"what's wrong there" question and get_machine_detail when they name the area.

## When asked what you can do, ask the server

If the operator asks what you can do, what you handle, what you are for, or what
your capabilities are, call describe_capabilities and read back its `speech`. Do
NOT recite a list from memory. The server knows which tools are actually live;
your memory of them goes stale the moment one is added or removed, and a
memorised list is how you end up offering something that no longer exists. For
remediations specifically — "what can you fix", "what playbooks do I have" —
call list_playbooks.

## Never invent names

Do not invent a branch, hostname, service, application or playbook name. The only
branches that exist are the seven below. If you are unsure what remediations
exist, call list_playbooks. If you are unsure what you can do at all, call
describe_capabilities. If you are unsure what is wrong or what is running on a
branch, call get_branch_status. Guessing a script name gets you a refusal and
wastes a turn in front of an audience.

## The seven branches

Nairobi HQ (also: headquarters, HQ)
Lagos (also: Lagos branch, Nigeria)
Dubai (also: UAE, Emirates)
London (also: UK)
Singapore (also: SG)
Sao Paulo (frequently misheard as "San Paulo" or "Sao Paolo" — all mean Sao Paulo)
New York (also: NYC, Manhattan)

If you hear a city that is not one of these seven, say you do not have a branch by
that name and name two that sound close. Never substitute your own guess.

## Refusals are normal

This platform enforces a policy tier on every command. Refusals are the system
working, not an error. If a tool says an action was refused by policy, or denied,
or that it cannot do something by voice, state that plainly in one sentence and
stop. Do not retry it. Do not try a different tool to achieve the same thing. Do
not apologise at length or explain the security model unless asked. "That was
refused by policy — it needs a higher tier" is a complete answer.

The same applies to partial results: if a tool says it opened the camera on 5 of
7 machines and the rest were refused, read that back exactly as given. Do not
round it up.

## Tone

Calm, terse, operational. You are a competent NOC engineer on a radio, not a
customer service bot. No filler, no enthusiasm, no "great question". Never
speculate about causes you have not been told.
```

### Why each rule is there

| Rule | The failure it prevents |
|---|---|
| Read `speech` verbatim | Model invents a machine count on stage. The numbers are computed in `voice.routes.ts`, not by the LLM. |
| Dispatch is not success | `run_playbook` returns the instant the row is queued. The machine agent has not even polled yet. |
| Ask on ambiguity | "San Paulo" sits within `0.25` of Sao Paulo; guessing means remediating the wrong branch. |
| Diagnose first | Restarting the spooler on a machine whose actual problem is a full disk looks incompetent. |
| Never invent names | `run_playbook` with an unknown action burns a turn reading back the menu. |
| Ask the server what you can do | A recited capability list drifts the moment a tool is added. `describe_capabilities` reads the live registry, so the answer cannot be stale. |
| Refusals are normal | An agent that retries a denied command looks broken; one that apologises for 30 seconds kills the pacing. |
| `ok: false` is still an answer | Every non-success carries usable `speech`. An agent that treats it as a failure loses the disambiguation question and the refusal text. |

---

## 3. Tool configuration

All eleven are **webhook tools**, method `POST`, to `{CONTROL_PLANE_URL}` + path.

Every one carries the same two headers:

```
x-sentinel-voice-key: <VOICE_WEBHOOK_SECRET>
content-type: application/json
```

### Response shape — read this before you configure anything

**Conversational outcomes return HTTP 200, including the refusals and the
questions.** Branch on the body's `ok` field, never on the HTTP status.

| Outcome | HTTP | Body |
|---|---|---|
| Success | `200` | `{"ok": true, "speech": "...", …extras}` |
| Disambiguation, unknown branch, policy refusal, no operator, missing playbook | `200` | `{"ok": false, "status": <real code>, "speech": "..."}` |
| Bad or missing shared secret | `401` | `{"speech": "I'm not authorised to do that."}` — no `ok` field |
| `VOICE_WEBHOOK_SECRET` unset on the server | `503` | `{"speech": "Voice control is not configured on the server."}` — no `ok` field |
| Unexpected server error | `500` | `{"ok": false, "status": 500, "speech": "Something went wrong reaching the fleet."}` |

The real code — `409` for "did you mean X or Y", `403` for a policy refusal,
`404` for an unknown branch, `503` for an unconfigured operator — is preserved
in the body as `status`, for logs and for the console. It is **not** the HTTP
status.

This is deliberate, and it is the single most important thing on this page.
Agent frameworks routinely treat a non-2xx tool response as a failed tool call
and discard the body before the model sees it. That would silently destroy the
two behaviours §2 leans on hardest: asking *"did you mean Nyali A or Nyali B?"*
instead of guessing, and reporting a policy refusal honestly. With the body
gone the agent has nothing to read back and improvises — which is the exact
failure a server-computed `speech` exists to prevent. Only the two things the
agent genuinely cannot act on stay non-2xx: a bad shared secret and an
unexpected exception. (The preHandler's `503` for an unset secret is also
non-2xx, for the same reason — nothing is configured, so there is nothing to
say.)

Every response is a JSON object with a `speech` string. Some carry extra fields
(`total`, `critical`, `commandIds`, `opened`, `refusalReason`); **the agent
should ignore those and read `speech`.** They exist for logs and for the
console, not for the model.

All eleven routes are present in `apps/control-plane/src/voice/voice.routes.ts`.
A tool wired to a path the deployed build does not have returns a transport
`404`, so verify each with `curl` against **the URL you will actually use**
before you present (§5) — a stale Render deploy is the realistic way this bites.

---

### `describe_capabilities`

**Path** `/v1/voice/capabilities` — **Body** `{}`

**Description to paste:**

> Describe what you can do, computed from the live registries on the server. Call
> this whenever the operator asks what you can do, what you handle, what you are
> for, or what your capabilities are — and read back the `speech` rather than
> reciting a list from memory. For remediation playbooks specifically, use
> list_playbooks instead. Takes no parameters.

```json
{ "type": "object", "properties": {}, "required": [] }
```

**Triggers:** "What can you do?" · "What are you for?" · "What do you handle?"

Every list in the answer is derived, not written: `VOICE_PLAYBOOKS` for
remediation, `LAUNCHABLE_APPS` and `CONTROLLABLE_SERVICES` from
`packages/contracts/src/vocabulary.ts` for apps and services, `DETAIL_TOPICS`
for machine detail. That is the point of the tool — a capability list written
into the system prompt is correct on the day it is written and wrong the day
someone adds an entry, and the way it goes wrong is the agent offering something
that refuses when the operator takes it up.

> **`playbooks` is an array of `{keyword, label}` objects, not strings.** Pass
> the **`keyword`** to `run_playbook`, never the `label`. `run_playbook` matches
> on the keyword appearing in the spoken action, and the keyword is not always a
> substring of the label — "check endpoint protection" is only reachable by
> saying **`security`**. Passing the label back would make the agent offer a
> capability and then fail to invoke it. A test round-trips every offer through
> `/v1/voice/remediate` to guarantee each one actually dispatches.

The `speech` is grouped and **headline-only**: counts plus the first three of
each ("I can start, stop or restart 9 services, including the Print Spooler, the
DNS Client and the DHCP Client"). Reading thirteen app ids aloud is not an
answer to "what can you do". The full lists come back in the structured fields —
`playbooks`, `scriptIds`, `apps`, `services`, `detailTopics` — for the agent to
narrow down from if asked.

If the script library failed to load the remediation sentence changes to say so
rather than being dropped, and the response is still `ok: true`.

---

### `get_fleet_status`

**Path** `/v1/voice/fleet` — **Body** `{}`

**Description to paste:**

> Get the health of the entire fleet across all seven branches at once: how many
> machines are registered, how many are critical, how many show warnings, and how
> many are offline. Use this for any broad, unscoped question about overall state
> — "how is everything", "how's the fleet", "any problems", "what's the status",
> "are we good". Do NOT use this when the operator names a specific branch; use
> get_branch_status for that. Takes no parameters.

```json
{ "type": "object", "properties": {}, "required": [] }
```

**Triggers:** "How is the fleet?" · "Everything alright out there?" · "Give me the overall status."

---

### `get_branch_status`

**Path** `/v1/voice/branch` — **Body** `{"branch": string}`

**Description to paste:**

> Get detailed per-machine health for ONE named branch: which machines are
> offline, which have printer faults, Enquest down, endpoint protection problems,
> low disk or high memory. Use this whenever the operator names a branch and asks
> what is happening there, and ALWAYS use it first when the operator reports a
> vague problem at a branch, before running any remediation. Pass the branch name
> exactly as you heard it — the server matches spoken names and nicknames itself.
> If the response asks "Did you mean X or Y?", ask the operator and call again.

```json
{
  "type": "object",
  "properties": {
    "branch": {
      "type": "string",
      "description": "Branch name as spoken, e.g. Lagos, Sao Paulo, NYC, headquarters. Do not normalise or correct it."
    }
  },
  "required": ["branch"]
}
```

**Triggers:** "What's wrong in Lagos?" · "Something's up with Sao Paulo." · "Check New York for me."

> The route also accepts `query` as an alias for `branch`. Use `branch`.

---

### `get_machine_detail`

**Path** `/v1/voice/detail` — **Body** `{"branch": string, "topic": string}`

**Description to paste:**

> Get the numbers behind a branch's status for ONE subsystem: printers, network,
> disk, services, endpoint security, or Enquest. Use this when the operator names
> the area they care about, or asks *why* something is broken — "how are the
> printers in Dubai", "what does disk look like in Lagos", "is Enquest up in
> Singapore", "why is the network slow in London". Use get_branch_status instead
> for the broad "what's wrong there" question. Pass "all" for everything that
> needs attention. Pass the branch name exactly as you heard it; the server
> matches spoken names itself. If the response asks "Did you mean X or Y?", ask
> the operator and call again. If the response says the telemetry is not live,
> say so — do not present a stale reading as current.

```json
{
  "type": "object",
  "properties": {
    "branch": { "type": "string", "description": "Branch name as spoken." },
    "topic": {
      "type": "string",
      "enum": ["printer", "network", "disk", "services", "security", "enquest", "all"],
      "description": "The subsystem the operator asked about. Use all only when they want everything."
    }
  },
  "required": ["branch", "topic"]
}
```

**Triggers:** "How are the printers in Dubai?" · "Disk situation in Lagos?" · "Why is the network slow in London?"

This reads `telemetry.payload` — the full heartbeat — where `get_branch_status`
reads the `asset_health` roll-up columns. That is the difference between "the
printer is critical" and "HP LaserJet is offline, classified as a paper jam, 4
jobs queued".

| Topic | Answers with |
|---|---|
| `printer` | Per-printer online state, fault class, queue depth, error state |
| `network` | Link state, gateway IP, latency, packet loss, public IP, internet reachability |
| `disk` | Per-volume free percent and capacity. Flags **below 15%** — tighter than the 10% the fleet summary alerts on, because "getting tight" is worth saying before it becomes an alert |
| `services` | Which monitored services are not running, and their actual state |
| `security` | Endpoint protection product and status |
| `enquest` | Enquest service state and last successful sync age |
| `all` | **Only the areas that need attention**, not all six — six sections read aloud is a monologue nobody hears the end of. If nothing is wrong it says so and gives disk and network anyway. |

Matching on `topic` is a substring test, so "printers" hits `printer`. An
unrecognised topic comes back `200 {"ok": true, …}` with a spoken menu of the
six. Same branch matcher as `get_branch_status`, so the same disambiguation
behaviour: `200 {"ok": false, "status": 409, "speech": "Did you mean X or Y?"}`.

**The stale-data rule matters here.** It reads the single newest telemetry row
across the branch's machines. If that row is older than **5 minutes** (five
missed heartbeats) the `speech` *leads* with a warning — *"Careful: the newest
telemetry from LAGOS-01 at Lagos is 12 minutes old, so this is not live. As of
then, …"* — rather than footnoting it. The body also carries `stale`,
`recordedAt` and `ageSeconds`. An operator acting on an hour-old latency reading
believing it live is worse than being told there is nothing fresh. If no
telemetry exists at all: `200 {"ok": false, "status": 404, …}`.

> The route also accepts `query` as an alias for `branch`. Use `branch`.

---

### `list_playbooks`

**Path** `/v1/voice/playbooks` — **Body** `{}`

**Description to paste:**

> List the remediation playbooks that can be run by voice. Call this when the
> operator asks what you can fix, what you can do, or what your options are — and
> call it before guessing at a playbook name you are not certain exists. Takes no
> parameters.

```json
{ "type": "object", "properties": {}, "required": [] }
```

**Triggers:** "What can you fix?" · "What playbooks do I have?"

The allowlist in `voice.routes.ts` (`VOICE_PLAYBOOKS`) is:

| Spoken keyword | Script | Does |
|---|---|---|
| `spooler`, `printer` | `restart-spooler` | Restart the print spooler |
| `print queue` | `clear-print-queue` | Clear the print queue |
| `test print` | `test-print` | Send a test print |
| `dns` | `flush-dns` | Flush DNS |
| `network`, `gateway` | `ping-gateway` | Test the gateway |
| `health` | `windows-system-health` | System health check |
| `security` | `defender-status` | Check endpoint protection |
| `enquest` | `enquest-check-services` | Check Enquest services |

Matching is a substring test against the lowercased `action`, so "restart the
print spooler" hits `spooler`. Anything containing none of those keywords comes
back `200 {"ok": true, …}` with a spoken menu of the above — the menu *is* the
successful answer, not an error.

`list_playbooks` speaks the *labels*, deduplicated, not the script ids:
"restart the print spooler", "clear the print queue", "send a test print",
"flush DNS", "test the gateway", "run a system health check", "check endpoint
protection", "check Enquest services". Script ids are returned as `scriptIds`
for the console; nobody says "restart-spooler" out loud.

If the script library did not load on the server this returns
`200 {"ok": false, "status": 503, …}` — see the troubleshooting table.

---

### `run_playbook`

**Path** `/v1/voice/remediate` — **Body** `{"branch": string, "action": string}`

**Description to paste:**

> Dispatch a hash-pinned remediation playbook to every machine at one branch.
> This SENDS the command; it does not complete it. The response confirms dispatch
> only — you must call check_status afterwards before telling the operator
> anything worked. Use this when the operator names a fix: restart the print
> spooler, clear the print queue, send a test print, flush DNS, test the gateway,
> run a health check, check security, check Enquest. If the operator has only described a symptom,
> call get_branch_status first. Pass their words straight through in `action`; the
> server matches them to the allowlist.

```json
{
  "type": "object",
  "properties": {
    "branch": { "type": "string", "description": "Branch name as spoken." },
    "action": {
      "type": "string",
      "description": "The remediation as the operator described it, e.g. restart the print spooler, flush dns, check enquest. Free text; the server matches it against an allowlist."
    }
  },
  "required": ["branch", "action"]
}
```

**Triggers:** "Restart the print spooler on Lagos." · "Flush DNS across Dubai."

Runs at tier **T3** against every asset at the branch, through the same
`dispatchCommand()` the console uses — same policy check, same `audit_log` row.

The success `speech` is exactly:

> *"Dispatched: restart the print spooler on 1 machine at Lagos. Ask me to check the status in a few seconds."*

It says **"Dispatched"**, and it ends by pointing at `check_status`. It does
**not** say "I'll report back when it completes" — that wording was removed
because nothing in this system pushes a result anywhere. The route returns the
moment the row is queued; the only way to learn the outcome is to ask.

> **Known wart.** The menu `run_playbook` reads back when nothing matches is a
> hardcoded sentence in the route and currently omits **send a test print**,
> which `VOICE_PLAYBOOKS` does accept. `list_playbooks` builds its list from the
> table and gets it right. Prefer `list_playbooks` when the operator asks what
> can be fixed; if you hear the short menu on stage, "send a test print" still
> works.

---

### `control_service`

**Path** `/v1/voice/service` — **Body** `{"branch": string, "service": string, "action": "start"|"stop"|"restart"}`

**Description to paste:**

> Start, stop or restart an allowlisted Windows service on the machines at one
> branch. This SENDS the command; it does not confirm the service came back. Use
> check_status afterwards before reporting an outcome. Permitted services only:
> spooler, dns, dhcp, time, defender, workstation, netlogon, update, enquest —
> use that short identifier, not the raw Windows service name. If the operator
> names a service that is not on the list, say so rather than substituting a
> similar one. For a straight print-spooler restart prefer run_playbook, which
> uses a hash-pinned script.

```json
{
  "type": "object",
  "properties": {
    "branch":  { "type": "string", "description": "Branch name as spoken." },
    "service": {
      "type": "string",
      "enum": ["spooler", "dns", "dhcp", "time", "defender",
               "workstation", "netlogon", "update", "enquest"],
      "description": "Allowlisted service identifier. Lowercase, not the raw Windows service name."
    },
    "action":  { "type": "string", "enum": ["start", "stop", "restart"] }
  },
  "required": ["branch", "service", "action"]
}
```

**Triggers:** "Restart the DNS client on London." · "Stop the spooler service in Singapore."

The mapping lives in `apps/agent-node/src/exec/service-actions.ts`:

| Identifier | Windows service | Identifier | Windows service |
|---|---|---|---|
| `spooler`, `printer`, `print spooler` | `Spooler` | `defender` | `WinDefend` |
| `dns` | `Dnscache` | `workstation` | `LanmanWorkstation` |
| `dhcp` | `Dhcp` | `netlogon` | `Netlogon` |
| `time` | `W32Time` | `update`, `windows update` | `wuauserv` |
| `enquest` | `Enquest` | | |

The spoken string never reaches a shell: it selects a fixed service name from
that table, and `start`/`stop`/`restart` select a fixed cmdlet. All three are in
the **T3** allowlist.

The success `speech` is exactly:

> *"Sent a restart of the spooler service to 1 machine at Lagos. Ask me to check the status in a few seconds."*

Same discipline as `run_playbook`: **sent**, not done. A missing `service` or an
action that is not start/stop/restart comes back `200 {"ok": true, …}` with a
one-line question or menu — those are answers, not errors. `defender` is
deliberately *in* the allowlist so that "stop Defender" is refused by the T6
deny-list check and lands in `audit_log` as a deny-pattern hit, rather than
looking like an unknown-service typo.

---

### `check_status`

**Path** `/v1/voice/status` — **Body** `{"branch": string}` *(branch optional)*

**Description to paste:**

> Check the outcome of recently dispatched commands. THIS IS THE ONLY TOOL THAT
> CAN TELL YOU WHETHER SOMETHING WORKED. Call it every time the operator asks
> "did it work", "is it fixed", "is it back up", "did that go through", and call
> it after any run_playbook or control_service before you describe any result.
> Pass a branch to scope it to one branch, or omit the branch for the whole fleet.
> If the response says a command is still pending or running, say so and offer to
> check again — never assume it finished.

```json
{
  "type": "object",
  "properties": {
    "branch": {
      "type": "string",
      "description": "Optional. Branch name as spoken. Omit for fleet-wide."
    }
  },
  "required": []
}
```

**Triggers:** "Did that work?" · "Is Lagos back?" · "Any results yet?"

Reads the last 20 `command_runs` rows from a **15-minute window** — older rows
are history, not "did that just work?", and including them would have the agent
report a stale success after a fresh failure. With nothing in the window the
`speech` is *"Nothing has been run on Lagos in the last fifteen minutes."*
Otherwise it counts succeeded / failed / refused / still running and then names
the first thing that went wrong, because a bare count tells the operator
something is broken without telling them what to look at.

Pass `"all"` (or omit `branch`) for the whole fleet; the label in the `speech`
becomes "the fleet".

---

### `open_machine`

**Path** `/v1/voice/open` — **Body** `{"branch": string}`

**Description to paste:**

> Open a live remote-desktop session to a machine at the named branch on the
> operator's own screen. Use this when the operator wants to see or take control
> of a branch machine: "open Lagos", "show me Dubai", "let me into New York",
> "pull that machine up". This changes what is on the operator's console, not the
> state of the remote machine.

```json
{
  "type": "object",
  "properties": {
    "branch": { "type": "string", "description": "Branch name as spoken." }
  },
  "required": ["branch"]
}
```

**Triggers:** "Open Lagos." · "Show me what's on the New York machine."

Opens the first machine at that branch, alphabetically by hostname. If the branch
has not reported an IP yet the route answers `200 {"ok": false, "status": 409,
…}` with a plain explanation — read it back, do not retry.

> The route also accepts an optional `mode` of `"view"` or `"control"` (default
> `"control"`). Leave it out unless you deliberately want a read-only demo.

---

### `launch_app`

**Path** `/v1/voice/launch` — **Body** `{"branch": string, "app": string}`

**Description to paste:**

> Launch an allowlisted Windows application on a machine at the named branch.
> Permitted apps only: notepad, calculator, explorer, chrome, edge, camera,
> taskmanager, eventviewer, services, control. Use the short identifier, not a
> sentence. If the operator asks for an application that is not on that list, say
> it is not one you can launch rather than substituting a similar one. To open the
> camera everywhere at once, use open_all_cameras instead.

```json
{
  "type": "object",
  "properties": {
    "branch": { "type": "string", "description": "Branch name as spoken." },
    "app": {
      "type": "string",
      "enum": ["notepad", "calculator", "explorer", "chrome", "edge", "camera",
               "taskmanager", "eventviewer", "services", "control"],
      "description": "Allowlisted app identifier. Lowercase, single token."
    }
  },
  "required": ["branch", "app"]
}
```

**Triggers:** "Open Chrome on Lagos." · "Bring up Task Manager on Dubai."

Runs at **T2** on one machine. The allowlist lives in
`apps/agent-node/src/exec/app-launcher.ts`; the spoken string never reaches a
shell — it selects a fixed command from a table, and anything not in the table is
refused by the executor.

> The route also accepts `appId` as an alias for `app`. Use `app`.

---

### `open_all_cameras`

**Path** `/v1/voice/cameras` — **Body** `{"branch": string}` — `"all"` for everywhere

**Description to paste:**

> Open the Windows Camera app across machines — on every branch at once, or on one
> named branch. Pass "all" for the whole fleet, or a branch name to scope it. This
> only opens the camera window on each machine; it captures nothing and uploads
> nothing. Expect a partial result: if some machines are refused by policy the
> response says how many opened, and you must read that number back exactly.

```json
{
  "type": "object",
  "properties": {
    "branch": {
      "type": "string",
      "description": "Branch name as spoken, or the literal string all for every branch.",
      "default": "all"
    }
  },
  "required": []
}
```

**Triggers:** "Open all cameras." · "Cameras on in Singapore."

Fans out in batches of 5 because `dispatchCommand()` auto-promotes anything
touching more than five assets to T5. A batch that hits the operator's tier
ceiling produces a partial `speech` — *"I opened the camera on 5 of 7 machines …
the rest were refused by policy"*. That sentence is the honest answer and the
agent must not round it up.

---

### Not a tool: `/v1/voice/speak`

`POST /v1/voice/speak` also exists but is **not** an ElevenLabs tool. It is a
server-side TTS proxy the web console calls for unprompted fault alerts, so the
`ELEVENLABS_API_KEY` never reaches a browser. It is deliberately exempt from the
shared-secret hook. Do not wire it into the agent.

---

## 4. Setup in the ElevenLabs dashboard

1. **Deploy the control plane to a public URL first.** Render, per runbook §8.
   Note it as `CONTROL_PLANE_URL`. Confirm from a device that is *not* on your
   venue Wi-Fi that `https://<url>/healthz` returns `{"status":"ok"}`.
2. **Set `VOICE_WEBHOOK_SECRET` in the Render dashboard** (`sync: false` in
   `render.yaml` keeps it out of git) and redeploy. Generate one with
   `node -e "console.log(crypto.randomUUID())"`. Until this is set every tool
   gets a 503.
3. **Create the agent.** ElevenLabs → Conversational AI → Agents → Create agent →
   blank template.
4. **Paste the system prompt** from §2 into the agent's System prompt field, in
   full.
5. **Pick the LLM.** A frontier model, not the cheapest option. Tool selection
   across eleven tools plus the dispatch-vs-outcome discipline *is* the job; a small
   model will read `speech` back fine and still pick the wrong tool.
6. **Add the eleven webhook tools** (Tools → Add tool → Webhook), one at a time:
   - Name and description from §3, copied exactly.
   - Method `POST`, URL `{CONTROL_PLANE_URL}` + path.
   - Headers `x-sentinel-voice-key: <VOICE_WEBHOOK_SECRET>` and
     `content-type: application/json`. **On every tool.** The header is not
     inherited; a tool missing it 401s while the other ten work, which is a
     miserable thing to debug live.
   - Body parameters from the schema. Mark `branch` required where §3 says so.
7. **Attach the tools to the agent.** Creating a tool in the library does not add
   it to the agent. Check the agent's tool list shows all eleven.
8. **Choose a voice.** Clear and low-latency — `eleven_turbo_v2_5` class. A
   dramatic narrator voice is unintelligible over room noise.
9. **The setting people forget: max conversation duration.** It defaults to a few
   minutes and will cut you off mid-demo. Raise it to 15+ minutes. While you are
   in there, raise the per-tool **response timeout** — a fan-out across seven
   machines is not instant, and a timed-out tool leaves the agent improvising,
   which is the single thing the prompt exists to prevent.
10. **Test each tool from the dashboard's tool tester** before you test by voice. A
    broken URL and a mis-heard branch name sound identical when you are talking.

### The mistake that will actually bite you

**ElevenLabs' servers make these HTTP calls, from their infrastructure.** They
cannot reach `http://localhost:8787`, and they cannot reach
`http://192.168.x.x:8787` — that is your venue Wi-Fi, not the internet.

A LAN-only control plane makes **every single tool call fail**, and the agent
keeps talking pleasantly while it happens. This is the most common setup mistake
by a wide margin.

The relay is the opposite case and stays on the command laptop (runbook §8) — it
dials private `192.168.x.x` addresses, which Render cannot route to. So during
the demo the control plane is public and the relay is local. Both are true at
once, and neither is a preference.

---

## 5. Verify before you present

Print the HTTP code with every call — the whole point is to confirm the
conversational ones are **200**.

```bash
CP=https://your-control-plane.onrender.com
KEY=<VOICE_WEBHOOK_SECRET>
V() { curl -s -w '\n[HTTP %{http_code}]\n' -X POST "$CP$1" \
        -H "x-sentinel-voice-key: $KEY" -H 'content-type: application/json' -d "$2"; }

# 200, {"ok":true,...}
V /v1/voice/fleet '{}'

# 200, {"ok":true,...} per-machine detail
V /v1/voice/branch '{"branch":"lagos"}'

# 200 with {"ok":false,"status":409,"speech":"Did you mean ...?"}
# The HTTP code MUST be 200. A 409 here means an old build is deployed.
V /v1/voice/branch '{"branch":"san paulo"}'

# 200 with {"ok":true,...} — the spoken playbook menu
V /v1/voice/playbooks '{}'

# 200, nothing dispatched yet is a valid answer
V /v1/voice/status '{}'

# 200. A transport 404 here means the deployed build predates these routes.
V /v1/voice/capabilities '{}'
V /v1/voice/detail '{"branch":"lagos","topic":"printer"}'

# 401 — the one that SHOULD be non-2xx. Proves the secret is being checked.
curl -s -o /dev/null -w '%{http_code}\n' -X POST $CP/v1/voice/fleet \
  -H 'x-sentinel-voice-key: wrong' -H 'content-type: application/json' -d '{}'
```

Then run the same handful by voice. Passing with `curl` and failing by voice
means the header is missing on that specific tool, or the tool is not attached to
the agent.

> **Check `ok`, not the HTTP status.** Disambiguation, policy refusal, unknown
> branch and unconfigured operator all come back **HTTP 200** with `ok: false`
> and the real code in `status` (§3). That is the design: it stops an agent
> framework discarding the body of a "failed" tool call and taking the
> disambiguation question and the refusal text with it — two of the three things
> §2 tells the agent to read back.
>
> Two consequences for your tool config. First, if you added any success
> condition based on HTTP status, `200` covers everything you need — do not add
> one on the body. Second, `401` and `500` are still non-2xx and their bodies
> may well be dropped; that is fine, because neither is something the agent can
> act on. Confirm in the tool tester that the "san paulo" call surfaces its
> `speech` to the model.

---

## 6. Rehearsal dialogue

Run this end to end at least once. It covers the two turns most likely to go
wrong: an ambiguous branch name, and a policy refusal.

| # | Operator says | Tool called | Agent says |
|---|---|---|---|
| 1 | "How is the fleet?" | `get_fleet_status` | *"7 machines are registered. 1 critical: Lagos. 1 showing warnings."* |
| 2 | "What's wrong in Lagos?" | `get_branch_status` `{"branch":"Lagos"}` | *"Lagos has 1 of 1 machines with problems. LAGOS-01: printer fault."* |
| 3 | "Restart the print spooler there." | `run_playbook` `{"branch":"Lagos","action":"restart the print spooler"}` | *"Dispatched: restart the print spooler on 1 machine at Lagos. Ask me to check the status in a few seconds."* |
| 4 | "Did it work?" | `check_status` `{"branch":"Lagos"}` | Reads back whatever `check_status` returns. **If it says pending, the agent says pending.** |
| 5 | "Now check San Paulo." | `get_branch_status` `{"branch":"San Paulo"}` → `200 {"ok":false,"status":409}` | *"Did you mean Sao Paulo or Singapore?"* — then it **stops and waits.** |
| 6 | "Sao Paulo." | `get_branch_status` `{"branch":"Sao Paulo"}` | *"Sao Paulo is fully healthy across 1 machines."* |
| 7 | "Open all cameras." | `open_all_cameras` `{"branch":"all"}` → partial | *"I opened the camera on 5 of 7 machines across all branches. The rest were refused by policy: …"* — exactly, not rounded. |
| 8 | "Try again." | *(none)* | *"That was refused by policy, so retrying won't change it."* No retry. |
| 9 | "Open Lagos." | `open_machine` `{"branch":"Lagos"}` | *"Opening LAGOS-01 at Lagos on your screen now."* |
| 10 | "What can you do?" | `describe_capabilities` `{}` | Reads back the server's grouped headline answer. **It must not recite a list from memory.** |
| 11 | "Why is the printer down there?" | `get_machine_detail` `{"branch":"Lagos","topic":"printer"}` | *"LAGOS-01 at Lagos, reported 1 minute ago: 1 of 2 printers have a problem: …"* — and if it leads with *"Careful: … is not live"*, the agent says that too. |

Turns 5 and 8 are the ones to drill. An agent that guesses "Sao Paulo" at turn 5
gets it right by luck and will guess wrong on stage; an agent that retries at
turn 8 burns fifteen seconds looking broken.

Turn 3 is the other one to listen closely to. The `speech` ends *"Ask me to check
the status in a few seconds"* — it deliberately does **not** promise to report
back, because nothing in this system pushes a result anywhere. If you hear the
agent say it will follow up, it has paraphrased, and §2's verbatim rule is not
being followed.

**The line worth saying out loud** while turn 3 runs, with `audit_log` on screen:
every voice command goes through the same `dispatchCommand()`, the same policy
check and the same audit row as a typed one. Voice is an input method, not a
privilege escalation path.

---

## 7. Troubleshooting

Codes written **`HTTP 401`** are real HTTP statuses. Codes written
**`status: 409`** are the body field on an HTTP 200 (§3) — if `curl` shows those
as the HTTP status instead, you are running an old build.

| Symptom | Cause | Fix |
|---|---|---|
| Every tool returns **`HTTP 401`** | `x-sentinel-voice-key` doesn't match `VOICE_WEBHOOK_SECRET` | Compare byte for byte; watch for a trailing newline pasted from a terminal. Redeploy after changing it on Render — env changes need a restart. |
| **One** tool 401s, the rest work | Header missing on that tool only | Headers are per-tool in ElevenLabs, not inherited. Add it. |
| Every tool returns **`HTTP 503`** *"Voice control is not configured on the server"* | `VOICE_WEBHOOK_SECRET` unset on the server | Set it in the Render dashboard and redeploy. The routes refuse rather than running open — intentional, not a bug. |
| Every tool times out or errors on connect | Control plane on localhost or a `192.168.x.x` LAN address | ElevenLabs calls *in*, from their servers. Deploy publicly (runbook §8). **Most common setup mistake.** |
| One tool returns a transport **`HTTP 404`** | That path is not in the deployed build — usually a stale Render deploy | Redeploy. All eleven routes exist in `voice.routes.ts`; check §5 against the URL the tool actually calls. |
| Agent paraphrases or invents numbers | System prompt not enforcing verbatim `speech` | Re-paste §2 in full; do not trim the "READ IT BACK VERBATIM" paragraph. Check the model is not a small/fast tier. |
| Agent says "fixed" / "back up" right after dispatching | Dispatch-vs-outcome rule missing or weakened | Re-paste §2, and verify `check_status` is attached to the agent — the rule is unfollowable if the tool is not there. |
| Agent says it will report back when the playbook completes | Paraphrasing. That string is not in any `speech` — the real one says *"Ask me to check the status in a few seconds."* | Re-paste §2. Nothing pushes a result anywhere; only `check_status` can answer. |
| Agent picks a branch instead of asking | Prompt problem, not transport — the disambiguation now arrives as `HTTP 200` and cannot be swallowed | Re-paste §2's "Ambiguity: ask, never guess". Confirm with the "san paulo" call in §5 that the body really is `200`; a literal `HTTP 409` means an old build is deployed. |
| **`status: 503`** *"No operator account is configured yet"* | Bootstrap seed not run, or no confirmed user when it ran | Runbook §2: create the operator in Supabase Auth, re-run `003_bootstrap_demo.sql`, confirm `access_grants >= 7`. Or pin `VOICE_OPERATOR_ID`. |
| **`HTTP 500`** *"Something went wrong reaching the fleet"* on any branch tool | Migration `0024` not applied — `resolve_branch_by_voice` RPC missing | Apply it. The real error is in the control-plane logs, not the `speech`. This one is genuinely non-2xx: the agent cannot act on it. |
| **`status: 403`** *"That was refused by policy"* | Operator's role caps below the tier the command needs | Expected behaviour. Check `audit_log`. The seed grants `it_manager`; a lower role caps out sooner. The body also carries `refusalReason`. |
| **`status: 404`** *"I couldn't find a branch called …"* | The spoken name matched nothing in `sites.name` + `sites.voice_aliases` | Check the alias is seeded (§1). Not a transport 404 — the tool call succeeded. |
| `run_playbook` reads back a menu instead of acting | The spoken `action` matched no keyword | Use the §3 keyword table. This is `200 {"ok": true}` — the menu *is* the successful response. |
| **`status: 503`** *"The … playbook isn't available on the server right now"* | Script library not found by `script-registry.ts` | Set `SENTINEL_SCRIPTS_DIR`, or confirm `packages/scripts/library` ships in the deploy. Startup logs `loaded N scripts`. |
| **`status: 409`** *"hasn't reported a network address yet"* on `open_machine` | Agent registered without a real LAN IP | Set `SENTINEL_HOST_IP` in that machine's `.env` (runbook §4). |
| Launched app never appears on screen | Machine agent installed as a Windows service (session 0) | Run it interactively from a normal terminal. Runbook §1 — the installer does this for you. |
| Conversation ends mid-demo | Max conversation duration default | Raise it (§4 step 9). |
| Tool call "fails" but the command actually ran | Per-tool response timeout too short on a fan-out | Raise the timeout, and check `command_runs` before re-dispatching. |
