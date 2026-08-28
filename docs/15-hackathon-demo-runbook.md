# Hackathon Demo Runbook — Sentinel Global Command Center

Everything needed to get 7 laptops live and run the demo. Follow it top to
bottom; the order matters, because each step verifies the one before it.

**Read this first:** the two things that most often kill this demo are
**AP client isolation** (the venue Wi-Fi refusing laptop-to-laptop traffic,
which breaks every remote session) and **an unrehearsed run**. Budget time
for a full dry run. A rehearsed two-feature demo beats a broken four-feature
one.

---

## 0. What you must supply

| Secret | Where it goes | Blocks |
|---|---|---|
| `SUPABASE_SERVICE_ROLE_KEY` (`eyJ…` JWT) | `apps/control-plane/.env`, `apps/relay/.env`, Render dashboard | **Everything.** Dashboard → Project Settings → API Keys on project `ncyerayycwkqytznnkrs`. This is *not* the `sbp_` personal access token. |
| Operator account | Supabase Dashboard → Authentication → Users → Add user (tick *Auto Confirm*) | Login, and every command (see step 2) |
| `ELEVENLABS_API_KEY` | `apps/control-plane/.env`, Render | Spoken alerts |
| `OPENAI_API_KEY` | `apps/sentinel-agent/.env`, Render | Natural-language questions |
| TightVNC password (same on all 7) | Seeded into the vault, step 2 | Remote desktop |

> Rotate any key that has been pasted into a chat window or a shared doc.

All five `.env` files are already created and filled in, except for the two
secrets. For the service_role key, paste it once:

```bash
node scripts/set-service-role-key.mjs
```

It reads from stdin (so the key never enters your shell history), rejects the
`sbp_` personal access token and the `sb_publishable_` key with a clear
message, and writes to both `apps/control-plane/.env` and `apps/relay/.env`.

The ElevenLabs key goes in `apps/control-plane/.env` by hand.

---

## 1. Install on all 7 laptops

**One command per laptop.** Open PowerShell on the machine (Start, type
`powershell`, Enter) and paste this:

```powershell
irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1 | iex
```

That is the whole thing. No git, no clone, no `cd`. It installs git if the
machine does not have it (one UAC prompt), clones the repo to
`%USERPROFILE%\it-sentinel`, and hands over to the installer, which shows its
disclosure screen, asks you to pick a branch from a numbered menu, and waits
for you to type `INSTALL`. Safe to run twice: a second run pulls instead of
cloning. Do the machines in parallel across your team; budget 10 minutes each.

> ### Before that URL works, two things must be true
>
> Neither is true as this is written. Check both, or skip to the USB fallback.
>
> 1. **`scripts/` has to be on `main`.** It is currently on the
>    `feat/hackathon-demo-platform` branch only. `origin/main` has no
>    `scripts/` folder, so the raw URL above returns 404. Merge and push
>    first, or point the script at another branch with `-Branch`.
> 2. **The repo has to be readable by the laptop.** `imodoiepale/it-sentinel`
>    is **private** today, so an unauthenticated laptop gets
>    `remote: Repository not found`. Either make it public before demo day,
>    or sign each laptop in to GitHub, or use the USB fallback.
>
> If the repo stays private, **use the USB fallback**. It is the more reliable
> plan for a venue anyway, and it does not depend on the network.

Flags for an unattended run: `-BranchSlug lagos`,
`-ControlPlaneUrl http://HUB_IP:8787`, `-VncPassword <pw>`. Omit any of them
and the installer prompts. `iex` cannot take arguments, so use this form
instead - still one line:

```powershell
& ([scriptblock]::Create((irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1))) -BranchSlug lagos -ControlPlaneUrl http://HUB_IP:8787
```

`bootstrap.ps1` also takes `-InstallRoot` (default `%USERPROFILE%\it-sentinel`),
`-Branch`, `-RepoUrl`, and `-NoInstall` (fetch the repo but stop before the
installer).

If `irm` itself fails with a TLS or "could not create SSL/TLS secure channel"
error - old Windows builds default to TLS 1.0 - prefix it once:

```powershell
[Net.ServicePointManager]::SecurityProtocol = 'Tls12'; irm https://raw.githubusercontent.com/imodoiepale/it-sentinel/main/scripts/bootstrap.ps1 | iex
```

### Fallback A - USB stick or network share, no GitHub needed

**This is the plan to use if the repo is still private on demo day.** It needs
no internet access to GitHub at all.

On the machine that already has the repo, copy the whole `it-sentinel` folder
to a USB stick or a share. Skip `node_modules` - the installer runs
`pnpm install` itself. Then on each laptop:

```powershell
powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\bootstrap.ps1
```

`bootstrap.ps1` notices it is already sitting inside a checkout, skips the
clone entirely, and goes straight to the installer. Or skip bootstrap and run
the installer directly - it winget-installs git itself, so nothing is lost:

```powershell
powershell -ExecutionPolicy Bypass -File D:\it-sentinel\scripts\install-sentinel-agent.ps1
```

To give each laptop its own working copy instead of running off the stick,
clone *from* the stick - `-RepoUrl` takes a path as happily as a URL:

```powershell
& ([scriptblock]::Create((gc -Raw D:\it-sentinel\scripts\bootstrap.ps1))) -RepoUrl D:\it-sentinel
```

A network share works the same way: `-RepoUrl \\HUB\share\it-sentinel`.

### Fallback B - the old multi-step way

If bootstrap misbehaves, this is what it was doing for you:

```powershell
git clone https://github.com/imodoiepale/it-sentinel.git
cd it-sentinel
.\scripts\install-sentinel-agent.ps1
```

### What the installer actually does

It does everything in this section and step 4: winget-installs Node LTS,
PowerShell 7, Git, Chrome and TightVNC, sets the VNC password, opens TCP 5900
in the firewall, writes `apps/agent-node/.env` for the branch you pick from a
menu, runs `pnpm install`, and starts the agent. It self-elevates, and it is
safe to run twice - every step probes before it acts, and it will not stack a
second agent process on a re-run.

> **It asks for the hub URL, so know `HUB_IP` first** (section 3). If you
> install before the hub exists, the agent starts and fails to reach it; fix
> `CONTROL_PLANE_URL` in `apps/agent-node/.env`, then close the agent window and
> re-run the installer. It will not repoint a running agent - it skips starting
> a second one and warns that the old one is still on the old `.env`.

Two things about it worth knowing before you run it on someone's laptop:

- **It shows a full disclosure and will not move until you type `INSTALL`.**
  That screen lists exactly what the heartbeat collects - down to event-log
  message text, installed software, and the fact that an operator can watch
  the desktop over VNC. Read it out to whoever owns the machine. **Have people
  sign out of anything personal, or use spare machines.**
- **It starts the agent INTERACTIVELY, not as a service**, and adds a Startup
  shortcut so it comes back at logon. This is the single most important thing
  in this section - see below.

**Do NOT install the agent as a Windows service** for this demo. A service runs
in session 0, where launched apps are invisible on screen: "open Notepad on
Lagos", "open Chrome on Lagos" and "open all cameras" would all report success
and show nothing to the room. `apps/agent-node/install-service.ps1` is the
production path; it is the wrong one here. The installer deliberately does not
use it, and the agent detects the situation and reports it.

Before you present, on every machine:

```powershell
.\scripts\preflight.ps1
```

Read-only, changes nothing, exits 0 only if everything passes. It re-checks
`.env` (branch slug against the seven known slugs, control-plane URL), `pwsh 7`,
the `tvnserver` service, port 5900 actually listening, the firewall rule, an
agent process actually running, `/healthz` on the hub, and the primary LAN IPv4
- i.e. the things that go stale between install time and stage time.

<details>
<summary><b>Fallback C: the manual steps, if the installer itself fails</b></summary>

Run **as Administrator**:

```powershell
winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements
winget install -e --id Microsoft.PowerShell
winget install -e --id Git.Git
winget install -e --id GlavSoft.TightVNC
winget install -e --id Google.Chrome
npm install -g pnpm
pnpm install
```

- **PowerShell 7 is mandatory.** The agent shells out to `pwsh`, not
  `powershell`. Verify with `pwsh -v`.
- **TightVNC**: same password on all 7, port 5900, tick *Register as a system
  service*, and **allow it through Windows Firewall** - the installer's
  checkbox is easy to miss and is the single most common reason remote desktop
  fails.
- Write `apps/agent-node/.env` by hand (step 4) and start the agent from a
  **normal terminal** - never as a service.

</details>

---

## 2. Bootstrap the database — do this before anything else

The live project has the full schema but started with **zero** users, access
grants and credentials. All three fail silently at demo time and look like
crashes, so they are fixed first.

1. **Create the operator** in the Supabase dashboard (Authentication → Users
   → Add user, *Auto Confirm* ticked).
2. **Run the seed** `packages/db/seed/003_bootstrap_demo.sql` in the SQL
   editor. It creates the 7 global-city sites and grants the operator
   `it_manager` on all of them.
3. **Check the output row it prints.** Expect `confirmed_users >= 1`,
   `demo_sites = 7`, `access_grants >= 7`. If `access_grants` is 0 the
   operator wasn't created — go back to step 1. Do not proceed on faith here.
4. **Seed the VNC credential** (once, after the agents have registered in
   step 4, so the assets exist):

```sql
-- credential_type MUST be 'vnc'. The column has a CHECK constraint allowing
-- only 'vnc' | 'windows_admin' | 'winrm' | 'other'; anything else fails with
-- a constraint violation. Verified against the live database.
select public.store_credential(
  'demo-vnc', 'vnc', '<your TightVNC password>', null, a.id, 90)
from public.assets a;

update public.assets a set credential_id = c.id
from public.credentials c where c.asset_id = a.id;
```

Then confirm every asset actually got one — a machine with a null
`credential_id` returns 403 on every session request:

```sql
select hostname, credential_id is not null as has_credential from assets order by hostname;
```

> This shares one credential across the fleet — a demo shortcut, not the
> production design. The vault, single-use 90-second tokens and
> "browser never sees a secret" flow are all real; per-device credentials and
> rotation are the gap. Say so if a judge asks.

Apply migrations `0025_per_asset_command_routing.sql` and
`0026_console_directives.sql` if they aren't already applied.

---

## 3. Start the hub (command laptop, e.g. Nairobi HQ)

Find your LAN IP with `ipconfig` — the IPv4 of the adapter on the venue
Wi-Fi. Call it `HUB_IP`.

`apps/control-plane/.env`:

```
SUPABASE_URL=https://ncyerayycwkqytznnkrs.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...
PORT=8787
RELAY_PUBLIC_URL=ws://HUB_IP:8788
VOICE_WEBHOOK_SECRET=<generate: node -e "console.log(crypto.randomUUID())">
ELEVENLABS_API_KEY=...
```

```bash
pnpm --filter @it-sentinel/control-plane dev   # :8787
pnpm --filter @it-sentinel/relay start         # :8788
pnpm --filter @it-sentinel/web dev             # :3210
```

Allow ports 8787/8788 through the hub's firewall, then from a **second**
laptop confirm `http://HUB_IP:8787/healthz` returns `{"status":"ok"}`. If it
doesn't, that is AP client isolation — see Troubleshooting.

---

## 4. Start the agents (all 7)

**`install-sentinel-agent.ps1` already did this** (§1) — it wrote the `.env` and
started the agent. This section is what it wrote, for when you need to change a
branch or repoint at a new hub by hand.

`apps/agent-node/.env`, changing the two branch lines per machine:

```
CONTROL_PLANE_URL=http://HUB_IP:8787
HEARTBEAT_INTERVAL_MS=15000
COMMAND_POLL_INTERVAL_MS=3000
SENTINEL_BRANCH_SLUG=lagos
SENTINEL_BRANCH_NAME=Lagos
```

Slugs: `nairobi-hq`, `lagos`, `dubai`, `london`, `singapore`, `sao-paulo`,
`new-york`.

```bash
pnpm --filter @it-sentinel/agent-node start
```

Each agent should log `identified as asset <uuid> (192.168.x.x)`. **If the IP
shown is not the machine's real LAN address**, set `SENTINEL_HOST_IP` in its
`.env` — the auto-detector skips known virtual adapters but a machine with
several NICs can still pick wrong, and remote desktop needs this right.

---

## 5. Verify before you present

Run `.\scripts\preflight.ps1` on each of the 7 first — it catches the per-machine
regressions (agent died, hub moved, someone rebooted and never logged back in)
without you thinking about them. Then do all five below by hand. Each one has
failed for a real reason during this build.

1. **Login** with the operator account. Fails if step 2 was skipped.
2. **All 7 branches show machines**, green, within 15 seconds.
3. **Command isolation** — the one that must not be skipped:
   ```sql
   select a.hostname, c.command_text, c.outcome
   from command_runs c join assets a on a.id = c.asset_id
   order by c.created_at desc limit 10;
   ```
   Dispatch something to Lagos and confirm **only Lagos** ran it. Before
   migration 0025 any agent could pick up any command.
4. **Break something**: `.\scripts\simulate-fault.ps1 -Fault printer-down` on
   one laptop. Within ~15s the row goes red and the announcer speaks. Click
   the page once first — browsers block autoplay until you interact, and the
   first alert would otherwise be silently swallowed.

   > **Do not use `Stop-Service Spooler` for this.** An earlier version of
   > this runbook told you to, and it does not work: with the spooler down
   > `Win32_Printer` returns nothing, so `printers[]` is empty and the
   > heartbeat reports `printer: "unknown"` — which is not a fault, so the row
   > stays green and the dot goes grey. `simulate-fault.ps1` sets the printer's
   > `WORK_OFFLINE` attribute instead, which is what `collect.ps1` actually
   > reads. See [17-fault-simulation.md](17-fault-simulation.md).
5. **Remote desktop**: open a machine, confirm the screen paints and you can
   type into it.

Before any of that, from the repo root:

```bash
pnpm verify
```

That typechecks every app and runs the full test suite (the security suites
included). It must be green before you start the hub.

> If you have `OPENAI_API_KEY` set in your shell to something that is not an
> OpenAI key, the Sentinel Agent now logs a warning and falls back rather than
> failing at ask time. Check its first log line says which planner it chose.

---

## 6. Demo script

| Say / do | What happens |
|---|---|
| "What can you do?" | Answer computed from the live registries, not recited |
| "How is the fleet?" | Counts read back from live data |
| "What's wrong in Lagos?" | Per-machine fault detail |
| "Why is the printer down there?" | The numbers behind it, from the raw heartbeat |
| `simulate-fault.ps1 -Fault printer-down` on Lagos | Row reddens, a p2 alert is raised, the agent announces it unprompted |
| "Clear the print queue on Lagos" | Hash-pinned playbook dispatches and genuinely drains the parked jobs |
| "Did that work?" | `check_status` reads the real command transcript back |
| `reset-faults.ps1` on Lagos | Back to green before the next run |
| "Open Lagos" | That laptop's screen opens in the browser |
| "Open Chrome on Lagos" | Chrome launches on the remote machine |
| "Open all cameras" | Camera app opens on every machine, in batches of 5 |

**The line worth saying out loud:** every one of those goes through the same
policy check and lands in the same `audit_log`. Voice is an input method, not
a bypass. And the agent cannot edit its own guard — `deny-list.ts` and
`tier-resolver.ts` are themselves on the deny list.

Have the audit trail on screen when you say it:

```sql
select action, decision, tier, detail from audit_log order by at desc limit 20;
```

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| Machines never appear | Agents can't reach the hub | `curl http://HUB_IP:8787/healthz` from another laptop; open the firewall port |
| Second laptop can't reach the hub at all | **AP client isolation** | Use a phone hotspot, or `winget install Tailscale.Tailscale` on all 7 for a private mesh (~3 min) |
| Remote desktop spins forever | `RELAY_PUBLIC_URL` wrong, or TightVNC firewalled | Check the agent's logged IP; confirm `Test-NetConnection <ip> -Port 5900` |
| "no credential configured" | Step 2.4 not run | Seed the credential |
| Every command 403s | No `site_access` grant | Re-run the seed; check `access_grants` |
| Commands run on the wrong machine | Migration 0025 not applied | Apply it; confirm `dequeue_commands` takes 3 args |
| Voice routes return 401 | Secret mismatch | `VOICE_WEBHOOK_SECRET` must match the ElevenLabs tool header |
| Launched app doesn't appear | Agent running as a service (session 0) | Run it from a normal terminal, or re-run `install-sentinel-agent.ps1`, which starts it interactively |
| Cameras open on some machines but not all | One batch of 5 hit the operator's tier ceiling | The `speech` says how many opened; check `audit_log` for the denied batch |
| Alert fires but nothing is spoken | Autoplay blocked | Click the page once |
| Fleet table looks empty | "Only show what's broken" is ticked | Untick it (now defaults off) |

---

## 8. Deploying to Render

`render.yaml` at the repo root defines the control plane and web console.
**The relay is deliberately not there:** it opens TCP connections to
`192.168.x.x` branch machines, and Render cannot route to private addresses.
It runs on the command laptop. This is a routing fact, not a preference.

Set `SUPABASE_SERVICE_ROLE_KEY`, `RELAY_PUBLIC_URL`, `VOICE_WEBHOOK_SECRET`
and `ELEVENLABS_API_KEY` in the dashboard (`sync: false` keeps them out of
git). Use a paid instance — free-tier cold starts run ~50 seconds, and that
is exactly when the judges are watching.

---

## 9. ElevenLabs agent setup

**See [16-elevenlabs-agent-config.md](16-elevenlabs-agent-config.md)** — the
full system prompt, all eleven webhook tools with their parameter schemas, the
dashboard setup steps, a rehearsal dialogue and a troubleshooting table.

That file is the single source of truth for the agent's configuration. This
section used to carry a shorter, separate copy of the tool list; it drifted
within a day (two different names for the same tool, three tools missing), so
it now points instead of duplicating.

The two rules worth repeating here, because they are what keep the agent
honest on stage:

- **Read the `speech` field back verbatim.** Every number in it is computed
  server-side from live data. Paraphrasing invites the model to invent a
  machine count in front of judges.
- **Dispatch is not success.** `run_playbook` and `control_service` return the
  moment a command is queued — the target machine has not even polled yet.
  The agent must call `check_status` before describing any outcome.
