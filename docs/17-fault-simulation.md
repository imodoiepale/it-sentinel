# Fault Simulation Kit — breaking branches on purpose

Two scripts and a choreography. `scripts/simulate-fault.ps1` induces a real,
reversible fault on a branch laptop; `scripts/reset-faults.ps1` puts it back.
Both are pure ASCII, run under Windows PowerShell 5.1 and pwsh 7, and detect
and explain missing elevation instead of dying on an access-denied.

**Read section 1 before you plan the demo.** Three things the runbook
currently promises do not happen, and one of them is the headline beat in
docs/15 §6. Better to find that here than on stage.

---

## 1. What actually shows up, and what does not

Everything the dashboard reddens on is decided in exactly one function:

```ts
// apps/control-plane/src/ingest/ingest.service.ts
function deriveHealthStatus(hb) {
  const substatuses = [hb.printer, hb.email, hb.endpointSecurity, hb.enquest];
  if (substatuses.includes("critical") || !hb.online) return "critical";
  if (substatuses.includes("warning")) return "warning";
  return "healthy";
}
```

Four fields. Nothing else. Not disk, not RAM, not network, not services, not
TightVNC, not queue depth. And alerts are raised in exactly one other place,
`evaluateChecks()`, for exactly two conditions: `enquest !== "healthy"` (p2 if
critical, else p3) and `endpointSecurity !== "healthy"` (p1).

Three consequences you have to plan around:

**1. `Stop-Service Spooler` does NOT redden a row, and the announcer does NOT
speak.** docs/15 §5.4 and §6 both say it does. It does not, for two
independent reasons. With the Spooler down `Get-CimInstance Win32_Printer`
returns nothing, so `printers[]` is empty and `toHeartbeat()` sets
`printer: "unknown"` — which is neither `critical` nor `warning`, so the row
stays green and the Printer dot goes **grey**. And nothing raises an alert for
a stopped service at all, so `AlertAnnouncer` — which only speaks p1 and p2 —
has nothing to say. Use `-Fault printer-down` for the red row. Use
`-Fault spooler-stopped` when you want the beat where a playbook genuinely
repairs something.

**2. Every machine already has a permanently-open p3 Enquest alert.**
`collect.ps1` hardcodes `enquestDetail.status = 'unknown'`. `unknown !==
"healthy"`, so the very first heartbeat from every laptop raises
`enquest_sync:<assetId>` at p3, and `raiseAlert()` dedups it open forever. It
is not a bug you introduced and it is not something you can simulate — it is
already there. Two knock-on effects: the alerts list is never empty, and
`newestOpenAlert()` at any branch returns the Enquest alert, which is what the
recurrence lookup keys off when the operator does not name a check (see §4).

**3. Nothing safely simulatable makes the voice agent announce a fault
unprompted.** The only p1 is endpoint security, and producing it means turning
off Defender real-time protection. Tamper Protection blocks it, and it is a T6
action the platform refuses by design. Do not do it, and do not promise the
room an unprompted announcement. The agent still reports faults perfectly well
when asked — that is the demo.

---

## 2. The fault table

`.\scripts\simulate-fault.ps1 -List` prints this too, so the script and this
table cannot drift apart in your head.

| Fault | What it breaks | Detection path | Red row? | Time to show | Operator says | Playbook that runs |
|---|---|---|---|---|---|---|
| `printer-down` | `WORK_OFFLINE` on the target queue + N jobs parked behind it | Win32_Printer.WorkOffline → `collect.ps1` L41 `online=$false` → `toHeartbeat()` `printer:"critical"` → `deriveHealthStatus()` → `asset_health.status='critical'`. Jobs → `queueDepth` → `checks.detail` and the voice printer topic | **Yes** | 1 heartbeat (15s) | "Clear the print queue on Lagos" | `clear-print-queue` (T3) — **genuinely drains it** |
| `printer-offline` | `WORK_OFFLINE` only, empty queue | as above, minus the queue | **Yes** | 1 heartbeat | "Why is the printer down in Lagos?" | none — no playbook clears an offline flag; `reset-faults.ps1` does |
| `spooler-stopped` | `Stop-Service Spooler` | `collect.ps1` L51-59 → `hb.services[Spooler].actualState='stopped'` → voice `services` topic: *"1 of 3 monitored services is not running: Spooler is stopped"*. Printer dot also goes grey | No | 1 heartbeat | "Restart the print spooler on Lagos" | `restart-spooler` (T3) — **genuinely repairs it** |
| `vnc-down` | `Stop-Service tvnserver` | `collect.ps1` L116 → `tightvnc:"stopped"` → `asset_health.tightvnc_status` → `FleetTable.tsx` renders the VNC dot red | No (VNC dot only) | 1 heartbeat | — | none — `tvnserver` is not in `CONTROLLABLE_SERVICES` |

None of the four raises an alert row, and therefore none of them makes the
announcer speak. That is a property of `evaluateChecks()`, not of the kit.

### The one honest caveat, stated plainly

`printer-down` reddens the board. `restart-spooler` does **not** clear a
persisted `WORK_OFFLINE` attribute — the Spooler re-reads it from the registry
on every start. So do not say "restart the spooler" and claim it cleared the
offline flag. What genuinely repairs on `printer-down` is
`clear-print-queue`: the jobs really are removed, and the next heartbeat
really does report `queueDepth: 0`. The offline flag comes off with
`reset-faults.ps1`.

If you want the full break → speak → repair → green loop with nothing to
qualify, that is `spooler-stopped` → "restart the print spooler" →
`restart-spooler`. It just does not redden the row on the way.

### Safety

- The default target is a **simulation printer** the kit creates,
  `IT-Sentinel-Sim`, on the `nul:` port. No physical device is involved and no
  paper is ever produced. `-Printer <name>` targets a real queue if you want a
  real printer name on screen; the queue is taken offline *before* any job is
  submitted, so it still cannot print.
- Nothing here deletes data, changes security settings, or needs a reboot.
- Every fault writes its undo state to
  `C:\ProgramData\ITSentinel\fault-sim-state.json` **before** it acts, so a
  script that dies halfway is still fully recoverable.
- `-WhatIf` is real and side-effect free. `-List` works unelevated.

### The detection preview — use it

After applying a fault the script re-computes, on that machine, the exact
expressions `collect.ps1` and `toHeartbeat()` use, then runs
`deriveHealthStatus()` over the result:

```
== Detection preview (what the next heartbeat will carry)
   printer                IT-Sentinel-Sim  [OFFLINE, 6 queued]
   hb.printer             critical
   hb.email               unknown   (hardcoded in collect.ps1)
   hb.endpointSecurity    healthy
   hb.enquest             unknown   (hardcoded in collect.ps1)
   service Spooler        running
   asset_health.status    CRITICAL
   + The fleet row WILL go red on the next heartbeat.
```

If it says `HEALTHY` after you broke something, the dashboard will not move.
Find that out at 9am, not at 2pm.

---

## 3. Not simulatable — and why that matters

Do not build a demo beat on any of these. Each is a real gap, and each is a
better answer to a judge than a hand-wave.

| Fault you might want | Why it produces nothing |
|---|---|
| Enquest down | `collect.ps1` hardcodes `enquestDetail.status = 'unknown'`. The p3 alert is already open on every machine and never changes. Killing an Enquest process changes no field the control plane reads. |
| Email / Outlook down | `collect.ps1` hardcodes `emailDetail.status = 'unknown'` the same way. The Email dot is permanently grey on every machine. |
| Endpoint security | The only p1 and the only thing the announcer would speak — and the only way to produce it is disabling Defender real-time protection. Tamper Protection blocks it, it is a T6 offence, and the kit refuses. |
| DNS broken / gateway down | Nothing in `ingest.service.ts` reads `hb.network`. `flush-dns` and `ping-gateway` are real playbooks with no detectable fault to pair them with. |
| Disk full | `diskFreePercent` is stored and rendered as a number in the Disk column, but it never reaches `deriveHealthStatus()` and never raises an alert. The number moves; nothing turns red. (The voice `disk` topic does call out anything under 15% free, and `/v1/voice/branch` mentions disk under 10%.) |
| RAM pressure | Same as disk. Number moves, no status changes. |
| Machine offline | `agent-node` hardcodes `online: true` in `toHeartbeat()`. A machine that stops reporting does not flip to offline; its `asset_health` row just stops updating, and nothing sweeps for staleness. |
| Stuck print queue alone | `queueDepth` never affects `hb.printer`, and the `printer_chain` check's status is derived from `p.online` alone. That is why `printer-down` sets the queue offline first. |

---

## 4. The recurrence script — and exactly what it does

**The intelligence is real and it is cross-branch. The data it reads is not
produced by anything in the running system.** Both halves matter.

### What exists

Two lookups, deliberately different:

- `getRecurrence(fingerprint)` — per-machine. Fingerprints are
  `fingerprintFor(checkType, assetId, faultClass)` = `checkType:assetId` (with
  `:faultClass` appended when present), so this can only ever answer "has this
  happened *on this laptop*".
- `getClassRecurrence(checkType, faultClass?)` — fleet-wide. Drops the assetId
  segment and does a `LIKE 'checkType:%'` prefix match, so Lagos's fault and
  Nairobi's fault land in the same bucket. It returns `timesSeen`,
  `assetsAffected`, a per-branch breakdown sorted worst-first, the most recent
  fix that worked, and that fix's own attempt/success record.

The voice layer wires the class-level one to two places:

- **`/v1/voice/recurrence`** — "Has this happened before at Lagos?" With no
  check named it reads the branch's newest **open alert** and uses its
  fingerprint's first segment. With a check named it matches an allowlist:
  `enquest`/`sync` → `enquest_sync`, `security`/`defender`/`protection` →
  `endpoint_security`, `printer`/`print` → `printer_chain`.
- **`/v1/voice/branch`** — "What's wrong in Lagos?" appends a recurrence
  sentence automatically, but only when the branch has an open alert *and*
  that check type has resolved history.

It is careful in ways worth pointing out to a judge: it refuses to quote a
success percentage off fewer than four graded attempts (it says "tried twice
and worked both times" instead), and when there is no history it says so
outright rather than inventing a plausible fix.

### What does not exist

**Nothing in this codebase ever resolves an incident.** Grep for
`resolution_summary`, `resolution_success` or `status = 'resolved'`: the only
hits are the migration that defines the columns and the two services that read
them. Incidents are created in one place only —
`POST /v1/alerts/:alertId/open-incident` — and they are created with
`status: 'open'`. Both recurrence lookups filter on `status = 'resolved'`.

So on a fresh database, **every recurrence question answers "no history"**, no
matter how many times you break and fix a branch during the demo. Running the
same fault at Lagos and then at Nairobi will not make the system say "we've
seen this before" on its own. Do not promise that it will.

**Second trap:** printer faults raise no alert at all. So the newest open
alert at any branch is always the permanent p3 Enquest one, and "has this
happened before?" *without naming a check* will look up `enquest_sync`. To get
printer history the operator must say the word **"printer"**.

### Making the recurrence beat work honestly

Seed the history in SQL before the demo, and say it is seeded if asked. This
is the fleet's prior incident record — the kind of data a real deployment
accumulates over months and a hackathon database has none of.

```sql
-- Prior resolved printer incidents across three branches. getClassRecurrence
-- matches on the 'printer_chain:' fingerprint prefix, so the assetId segment
-- only has to be a plausible uuid belonging to that branch.
insert into public.incidents
  (asset_id, site_id, fingerprint, severity, title, category, status,
   resolution_summary, resolution_success, opened_at, resolved_at)
select
  a.id,
  a.site_id,
  'printer_chain:' || a.id,
  'p3',
  'Printer offline on ' || a.hostname,
  'printer_queue',
  'resolved',
  'cleared the print queue',
  true,
  now() - (n || ' days')::interval,
  now() - (n || ' days')::interval + interval '20 minutes'
from public.assets a
join public.sites s on s.id = a.site_id
cross join generate_series(1, 2) as n
where s.slug in ('nairobi-hq', 'lagos', 'dubai');
```

Confirm it landed, and confirm the class lookup can see it:

```sql
select s.name, count(*)
from public.incidents i join public.sites s on s.id = i.site_id
where i.fingerprint like 'printer_chain:%' and i.status = 'resolved'
group by s.name order by 2 desc;
```

Then the beat runs:

1. `.\scripts\simulate-fault.ps1 -Fault printer-down` on **Lagos**. Row reddens
   within 15 seconds.
2. "What's wrong in Lagos?" → *"…printer fault."*
3. "Why is the printer down in Lagos?" → the queue name, offline, and the job
   count, read off the raw heartbeat.
4. "Clear the print queue on Lagos" → `clear-print-queue` dispatches. Then
   **"check the status"** — dispatch is not success, and the agent is
   configured to say so.
5. `.\scripts\reset-faults.ps1` on Lagos returns it to green.
6. Same fault on **Nairobi HQ**. Row reddens.
7. **"Has this happened before with the printer at Nairobi?"** — say
   "printer", because without it the agent looks up Enquest. The answer names
   the count, the branch spread, and the last fix that worked.

The line worth saying out loud: the fingerprint deliberately carries the
machine id so an open alert at Lagos never deduplicates an identical fault at
Nairobi — and the recurrence lookup deliberately strips it back off, because
"has anyone seen this" is a different question from "is this already
ticketed". Two keys, on purpose.

---

## 5. Pre-demo checklist

Per branch laptop, in an **Administrator** PowerShell, from the repo root:

- [ ] `.\scripts\preflight.ps1` passes (agent alive, hub reachable, VNC up).
- [ ] `.\scripts\simulate-fault.ps1 -List` runs — proves the file parses and
      the shell can execute it.
- [ ] `.\scripts\simulate-fault.ps1 -Fault printer-down -WhatIf` — shows the
      machine's current readings and changes nothing.
- [ ] **Rehearse the real thing once.**
      `.\scripts\simulate-fault.ps1 -Fault printer-down`, confirm the preview
      ends with `+ The fleet row WILL go red on the next heartbeat.`, watch
      the console redden, then `.\scripts\reset-faults.ps1` and confirm it
      ends with `This machine is GREEN.`
- [ ] Click the console page once before you present. Browsers block autoplay
      and the first spoken line is otherwise swallowed.
- [ ] Recurrence history seeded (§4) if you are running that beat.
- [ ] Decide which laptop gets which fault and write it on a sticky note. Two
      presenters both breaking Lagos is a very confusing minute.

Reserve `vnc-down` for a laptop you are not going to remote into. It breaks
the remote-desktop demo until you reset.

---

## 6. Reset everything

```powershell
.\scripts\reset-faults.ps1
```

Idempotent, safe on a machine that was never broken, and safe to run twice. It:

1. Starts the Spooler and `tvnserver` if either is stopped.
2. Restores the exact original `Attributes` DWORD on any printer the kit
   flagged, from the state file.
3. Removes queued jobs from those printers.
4. Clears, drains and deletes the `IT-Sentinel-Sim` printer — state file or
   not, so a lost state file is not a dead end.
5. **Reports but does not touch** any other printer that is offline or holding
   jobs. That could be a genuine fault on a real device, and quietly
   "fixing" it would hide it from the dashboard.
6. Restarts the Spooler so the cleared attributes actually load.
7. Prints where the machine ended up, in the same wire-field terms as the
   simulation preview, and tells you plainly whether it is green.

If something is still red and you know it is not real:

```powershell
.\scripts\reset-faults.ps1 -AllPrinters
```

That clears `WORK_OFFLINE` and drains **every** local queue, including ones
this kit never touched. It is the panic button. Read what it prints.

`-KeepSimPrinter` leaves `IT-Sentinel-Sim` installed between rehearsal runs.

A `finally` block guarantees the Spooler is running when the script exits,
even if it errored partway. A branch that cannot enumerate printers looks
broken on the dashboard and no playbook in the library can repair it from
there.

---

## 7. Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| "This needs to run elevated" | Not an Administrator shell | The message prints the exact `cd` and command to re-run. `-List` and `-WhatIf` do not need elevation. |
| Preview says `hb.printer critical` but the console stays green | The agent is not running, or is pointed at the wrong hub | `.\scripts\preflight.ps1`; check `CONTROL_PLANE_URL` in `apps/agent-node/.env` |
| Preview says `The fleet row will NOT go red` | The `WORK_OFFLINE` attribute did not take on this queue | Run `reset-faults.ps1`, then retry without `-Printer` so it uses the simulation queue |
| `jobs in queue 0` after `printer-down` | The driver rejected the job, or Windows PowerShell 5.1 is missing | The offline flag still applies and the row still reddens; there is just nothing for `clear-print-queue` to clear |
| Printer dot went **grey**, not red | `hb.printer` is `unknown` — Win32_Printer returned nothing, usually because the Spooler is down | That is `spooler-stopped` behaving as documented. `reset-faults.ps1` |
| Row red, and reset says it is still critical | A *real* printer is offline and the sweep refused to touch it | Read the `!` lines; `-AllPrinters` if you are sure |
| "No printer driver is installed" | Microsoft Print to PDF was removed from the image | Pass `-Printer <an existing local queue>` |
| Queue depths look doubled | `collect.ps1` counts jobs with a prefix `LIKE '<name>%'`, so "HP LaserJet" swallows "HP LaserJet (copy 1)" | Cosmetic; target the simulation printer to avoid it |
| Recurrence always says "no history" | Nothing in the system resolves incidents | Seed it — §4 |
| "Has this happened before" answers about Enquest | No check named, so it read the permanent p3 Enquest alert | Say the word "printer" |
| Remote desktop stopped working | `vnc-down` is still active | `.\scripts\reset-faults.ps1` |

---

## 8. Files

| File | Purpose |
|---|---|
| `scripts/simulate-fault.ps1` | Induce one fault. `-List`, `-WhatIf`, `-Printer`, `-Jobs`, `-SkipVerify`. |
| `scripts/reset-faults.ps1` | Undo everything. `-AllPrinters`, `-KeepSimPrinter`, `-WhatIf`. |
| `C:\ProgramData\ITSentinel\fault-sim-state.json` | Undo state, written before each fault is applied. Deleted by a clean reset. |

Both scripts are **pure ASCII with no BOM** on purpose. Windows PowerShell 5.1
reads a BOM-less `.ps1` as ANSI, and a UTF-8 em dash becomes two bytes it
treats as string delimiters — the script then fails to parse with an error
that points nowhere near the real line. If you edit them, byte-scan before you
commit:

```powershell
$b = [IO.File]::ReadAllBytes('scripts\simulate-fault.ps1')
($b | Where-Object { $_ -gt 127 }).Count   # must be 0
```
