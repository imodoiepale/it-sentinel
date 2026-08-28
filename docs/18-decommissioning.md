# 18 — Decommissioning: getting a machine out of the fleet

These are teammates' personal laptops. When the demo is over, every owner has
to be able to get their machine completely out: no agent running, no telemetry
leaving the box, no remote access, no firewall hole left open.

That is **two jobs, and neither one does the other's**:

| | Where | Who | What it does |
|---|---|---|---|
| **1. Clean the laptop** | on the machine | its owner | stops the agent, closes the firewall hole, removes the config |
| **2. Retire the asset** | control plane | an operator | takes the row off the roster and stops it alerting |

Do them **in that order**. Reason in §4.

---

## 1. On the laptop — `scripts/uninstall-sentinel-agent.ps1`

One command, in PowerShell, in the repo:

```powershell
.\scripts\uninstall-sentinel-agent.ps1
```

It shows exactly what it will remove and **will not move until you type
`UNINSTALL`** — the same disclosure-then-consent shape as the installer. It
self-elevates with one UAC prompt (the firewall rule and the TightVNC service
are machine-wide), and if UAC is declined it changes nothing and tells you the
two commands somebody with admin can run instead. Safe to run twice: every
step probes first and succeeds quietly if the thing is already gone.

### What it removes

| | |
|---|---|
| Agent process | anything whose command line matches `agent-node` — the `node.exe` **and** the console window `pnpm` was running in. Killing only `node.exe` leaves an empty window that reopens at logon. |
| Startup shortcut | `IT Sentinel Agent.lnk`. Nothing restarts at the next logon. Checked in both the elevated profile and the profile that launched it, because UAC resolves `shell:startup` to the wrong one otherwise. |
| `apps/agent-node/.env` | the control-plane URL and branch slug this machine reported to. |
| Firewall rule | `IT Sentinel - TightVNC (TCP 5900)`, by DisplayName — the exact string `install-sentinel-agent.ps1` creates and `preflight.ps1` looks for. Inbound 5900 is shut again on all three profiles. |

It also warns you if **some other** inbound rule still allows 5900 (TightVNC's
own installer adds one if you let it) and lists them by name. It does not
delete rules it did not create.

### What it deliberately leaves, and why

- **Node.js, PowerShell 7, Git, Chrome, pnpm.** General-purpose tools. The
  installer may have put them there, but by now other things on the machine
  depend on them, and uninstalling somebody's browser to tidy up after a
  hackathon is not acceptable. The script prints this on screen so the owner
  knows it was a decision and not an oversight, along with the four
  `winget uninstall` lines if they want them gone.
- **TightVNC — it asks, and the default is to leave it.** Plenty of people had
  TightVNC before this demo. The prompt offers: leave it alone (default), stop
  the service and set it to Manual start, or uninstall it entirely. Skip the
  prompt with `-VncAction leave|stop|uninstall`.
- **The repo, including `node_modules`.** Their disk, their call. The script
  prints the path. `-RemoveRepo` opts in and asks for a second typed
  confirmation, because that folder may hold uncommitted work.
- **`.env.bak`**, if the installer made one — it is a backup of whatever `.env`
  was there *before* the demo, so it is not ours to delete.
- **Everything already in the control plane.** Every command run on this
  machine and every remote session opened against it stays in `audit_log`.
  Uninstalling the agent is not a way to erase what was done.

It finishes with a re-probed `GONE / LEFT / KEPT / STILL` table — the mirror of
`preflight.ps1`, where `PASS` means the agent is ready to run and here `GONE`
means it cannot — then a checklist of what came off, what stayed, and the
server-side step still outstanding.

---

## 2. On the roster — retire, never delete

Migration `0027_asset_decommission.sql`. There is **no delete path anywhere in
the application**, and that is the design, not an omission.

### Why a soft delete

`command_runs`, `sessions`, `telemetry`, `alerts`, `checks`, `playbook_runs`
and `_session_tokens` all reference `assets` **`on delete cascade`**. One
`delete from public.assets` therefore destroys every elevated command ever run
on that machine, every remote-control session ever opened against it, and
every heartbeat it ever sent.

`audit_log` itself survives — `target_id` carries no FK — but its rows go
unreadable. An auditor holding *"adhoc_powershell on 6f2c…"* has no way left to
learn which machine that was, who owned it, or that it ever existed.

Attribution after the fact is this product's central security claim. A routine
"remove PC" button that quietly erases the record of what was run on a machine
would make destroying the evidence easier than reading it, and the person most
motivated to press it is the person with something to hide. So retirement is a
**reversible flag, gated on role, and audited**.

### What `retire_asset(p_asset_id, p_reason, p_actor_id)` actually does

1. Resolves the actor. `auth.uid()` wins when there is one; `p_actor_id` is
   honoured **only** for service-role callers with no JWT (the voice webhook,
   which resolves a real operator first). Accepting it from a logged-in session
   would let an operator retire a machine and have the audit row name somebody
   else.
2. Checks that actor's role **at that asset's own site**: `l3_sysadmin`,
   `security_admin` or `it_manager`. L1/L2 support are excluded — taking a
   machine off the board is a registry change, not a remediation — and so are
   auditors, whose job is to read the trail, not reshape it. The same check
   applies whichever door the call came through, so voice can never retire
   something the console would refuse.
3. Sets `decommissioned_at`, `decommissioned_by`, `decommission_reason`.
4. Ends every open `sessions` row for the asset and marks every unredeemed
   `_session_tokens` row redeemed. A live token is a key to a box we have just
   declared out of scope.
5. Writes an `asset.decommissioned` row to `audit_log` with the hostname, site,
   reason, whether it came via `service_role` or an `operator_session`, and how
   many sessions were closed. No `tier` — retirement executes nothing on the
   endpoint.
6. **Idempotent.** A second call returns `already_retired = true` and changes
   nothing: a double-clicked button or a repeated voice turn must not rewrite
   who retired the machine.

**It is not a kill switch.** It does not tear down a relay connection that is
already established (the relay holds a redeemed socket, not a row it
re-checks), and it does not stop the agent. The kill switch is
`uninstall-sentinel-agent.ps1`, run on the machine itself.

### What it does to the rest of the system

- **Roster reads** exclude retired rows. There is a partial index
  `assets_active_site_idx on assets (site_id) where decommissioned_at is null`
  for exactly that query.
- **RLS is unchanged.** `assets_read_scoped` (migration 0007) still returns
  retired rows on purpose. Hiding them at the RLS layer would look tidier and
  would silently break every `assets!inner(...)` embed in the console — the
  hostname column of an audit view would stop rendering and take the audit rows
  with it. RLS answers *"may this operator see this machine"*, and that answer
  does not change when it is retired.
- **`sweep_stale_assets()` now skips retired assets.** Without that clause a
  retired laptop alerts forever: the sweep exists so a silent agent never
  renders as healthy, and an uninstalled machine is silent by definition, so
  every five minutes it would be re-flipped to `stale` — the one status the
  system is built to make impossible to ignore. Retirement is the operator
  saying *"this silence is expected"*, and the sweep now hears it.
- **`restore_asset(p_asset_id, p_reason, p_actor_id)`** reverses it, under the
  same role check, and logs `asset.recommissioned` with the old
  `decommissioned_at`. Both the mistake and the correction stay in the log.

Neither function is grantable around: there is no direct update policy on
`assets`, `execute` is revoked from `public` and `anon` and granted only to
`authenticated` and `service_role`, so the role check and the audit row are
unavoidable rather than customary.

---

## 3. Three ways to retire a machine

**Voice** — landed at `POST /v1/voice/retire` (`apps/control-plane/src/voice/voice.routes.ts`):

> "Retire LAGOS-POS-01 at Lagos." → *"Retiring LAGOS-POS-01 takes it off the
> roster at Lagos and ends any open session on it. Say 'confirm retire' to go
> ahead."* → "Confirm retire."

Two turns, and it is the only voice route that is. Everything else the agent
does is read-only or reversible by saying the opposite; retirement changes the
registry, and speech recognition mishears hostnames constantly. It also refuses
to guess: more than one machine matching the hostname hint, or no hint at a
branch with several machines, comes back as a question. A `42501` from the role
check is spoken as a refusal rather than swallowed — voice is an input method,
not a bypass.

**Console** — the roster query in `apps/web/lib/useFleet.ts` now carries
`.is("decommissioned_at", null)`, so a retired machine disappears from the
fleet table as soon as it is retired. Retired rows are *not* hidden by RLS
(see above), so without that filter "remove that PC" would appear to do
nothing at all on the board.

The retire **button** on the machine's row is being added alongside this doc
and is not in `apps/web/components/FleetTable.tsx` yet as of writing. It calls
the same `retire_asset()` RPC, deliberately, so the button and the voice route
cannot diverge on who is allowed to do what. Until it lands, use voice or SQL.

**SQL** — the fallback that always works:

```sql
-- find the id
select a.id, a.hostname, s.slug
from public.assets a join public.sites s on s.id = a.site_id
where a.hostname = 'LAGOS-POS-01';

-- retire it
select * from public.retire_asset(
  '<asset uuid>',
  'demo over, agent uninstalled by owner',
  '<operator uuid>');
```

Run as `service_role` in the SQL editor, `p_actor_id` is required and must be a
real operator with the right role at that site — the function raises `28000` if
it is null and `42501` if the role is wrong. Do not invent a uuid to get past
it; the whole point of the column is that the audit row names a person.

---

## 4. Order of operations: laptop first, then roster

Retiring an asset **does not stop ingest**. `ingest.service.ts` looks the asset
up by hostname and site and does not filter on `decommissioned_at`, so an agent
still running after a retire keeps upserting `asset_health`, keeps inserting
`telemetry` rows and keeps bumping `assets.last_seen_at`. It will not
un-retire the machine — nothing in that path clears `decommissioned_at`, so the
row stays off the roster — but the machine goes on writing telemetry under a
retired id, and if it is later restored it comes back green as though nothing
had happened.

So: **uninstall on the machine, confirm it is silent, then retire.** If you
have to retire first (the owner has left with their laptop), retire it and get
the uninstall run as soon as you can.

---

## 5. Verifying a machine is fully out

### On the laptop

The uninstaller prints this table itself, but to check independently:

```powershell
# 1. no agent process
Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -match 'agent-node' }

# 2. no logon shortcut
Test-Path (Join-Path ([Environment]::GetFolderPath('Startup')) 'IT Sentinel Agent.lnk')

# 3. no firewall rule
Get-NetFirewallRule -DisplayName 'IT Sentinel - TightVNC (TCP 5900)' -ErrorAction SilentlyContinue

# 4. no agent config
Test-Path .\apps\agent-node\.env
```

Expect: nothing, `False`, nothing, `False`.

Then run the inverse check — **`.\scripts\preflight.ps1` should now fail
loudly**. A clean machine is a machine that is `NOT READY` to be a demo node.

### Server side

```sql
-- flag set, and who set it and why
select a.hostname, a.decommissioned_at, a.decommission_reason,
       a.decommissioned_by, a.last_seen_at, h.status, h.last_heartbeat_at
from public.assets a
left join public.asset_health h on h.asset_id = a.id
where a.hostname = 'LAGOS-POS-01';

-- absent from the roster: this list is what the console shows
select hostname from public.assets
where site_id = (select id from public.sites where slug = 'lagos')
  and decommissioned_at is null
order by hostname;

-- no new heartbeats. Expect 0.
select count(*) from public.telemetry
where asset_id = '<asset uuid>'
  and recorded_at > now() - interval '5 minutes';

-- and the history is still there and still readable
select at, action, decision, detail->>'hostname' as hostname
from public.audit_log
where target_id = '<asset uuid>'
order by at desc limit 20;
```

The last query is the one to run in front of a judge. The machine is off the
board, and every command ever dispatched to it is still attributable, by
hostname, to the person who ran it. That is the trade the soft delete buys.

---

## 6. Retired the wrong machine

```sql
select * from public.restore_asset(
  '<asset uuid>', 'retired in error during setup', '<operator uuid>');
```

Same role check, back on the roster immediately, and both the mistake and the
correction are in `audit_log`. If the agent was also uninstalled, re-run
`scripts\install-sentinel-agent.ps1` on the laptop — it is safe to re-run and
will rewrite `.env`, re-add the firewall rule and restart the agent.
