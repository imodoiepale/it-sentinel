# 19 — Enrollment: getting a machine into the fleet

The counterpart to [18 — Decommissioning](./18-decommissioning.md). A teammate
opens one page, picks their branch, copies one command, and ends up enrolled.

Nobody should need a repo checkout, a GitHub account, or somebody standing
over their shoulder reading a runbook aloud.

---

## 1. The short version

Sign in to the console and open **`/enroll`**. Pick a branch. Copy the command.
Paste it into Windows PowerShell on the laptop.

The page fills in the branch and the hub for you, so what you copy looks like
this:

```powershell
& ([scriptblock]::Create((irm https://it-sentinel-control-plane.onrender.com/v1/enroll/bootstrap.ps1))) -BranchSlug lagos -ControlPlaneUrl https://it-sentinel-control-plane.onrender.com
```

Without arguments — the installer then prompts for branch and hub:

```powershell
irm https://it-sentinel-control-plane.onrender.com/v1/enroll/bootstrap.ps1 | iex
```

The scriptblock form exists because `irm … | iex` has no way to pass
arguments, and pre-filling the branch is the entire point of the page.

From there it is the same install path that has always existed:
`bootstrap.ps1` fetches the code and hands over to
`install-sentinel-agent.ps1`, which shows its full disclosure and refuses to
change anything until the person at the keyboard types `INSTALL`.

---

## 1a. Or download something and double-click it

Not everybody wants to paste a command into PowerShell, so `/enroll` also
offers two launchers. Both do exactly what the one-liner does — download
`bootstrap.ps1` from this hub and run it. Neither makes a decision about the
machine, and the installer still waits for a typed `INSTALL`.

| | `SentinelSetup.cmd` | `SentinelSetup.exe` | the one-liner |
|---|---|---|---|
| Double-clickable | yes | yes | no |
| Readable before running | yes, it is text | no, it is a binary | yes |
| Windows warning | one "Run anyway" | full-screen blue SmartScreen panel | none |
| Branch menu | no | yes, fetched live | the installer asks |
| Available on the hosted hub | yes | **usually no** (§1c) | yes |

**Which to use.**

- **PowerShell is fine with you?** Use the one-liner. Fewest moving parts,
  and it is what the rest of these docs assume.
- **Sending this to a teammate?** Send the **`.cmd`**. It is plain text they
  can open in Notepad and read before running, and it does not trip the
  unsigned-binary machinery.
- **`.exe`?** Only when you specifically want the numbered branch menu, and
  only after warning the recipient about §1b.

**For demo day the recommendation is the one-liner, with the `.cmd` as the
fallback for anybody who balks at a terminal.** The `.exe` is the artifact
most likely to produce a security scare in front of an audience.

Full detail, including how to build the `.exe`, is in
[`installer/README.md`](../installer/README.md).

## 1b. The `.exe` is unsigned, and Windows will say so

Signing needs an Authenticode certificate nobody on this project has. An
unsigned binary that arrives through a browser and then launches PowerShell
is close to the textbook description of a dropper, and Windows treats it that
way. **This is the honest reason the `.exe` may be a worse experience than
the one-liner it was meant to replace.**

What a teammate sees:

1. The browser may flag the download first. Chrome shows *"SentinelSetup.exe
   is not commonly downloaded and may be dangerous"*, with **Keep** hidden
   behind the `⋮` menu on the download chip.
2. On double-click, a **full-screen blue panel**: *"Windows protected your
   PC — Microsoft Defender SmartScreen prevented an unrecognised app from
   starting."* The only visible button is **Don't run**.
3. The way forward is a small underlined **More info** link above that button.
   It is easy to miss, by design. Clicking it shows `Publisher: Unknown
   publisher` and reveals a second button, **Run anyway**.
4. Then the console window opens.

And a fifth outcome with no click-path: some Defender and most third-party AV
configurations **quarantine the file outright**, or kill the process when it
starts `powershell.exe`. The file vanishes from Downloads and nothing you
click brings it back. That is correct behaviour on a machine you do not
administer, not a bug to fix.

What was done about it, short of a certificate: `SentinelSetup.cs` sets real
assembly metadata (`AssemblyTitle`, `AssemblyProduct`, `AssemblyCompany`,
`AssemblyDescription`, `AssemblyVersion`), which csc turns into the Win32
version resource. A blank version resource scores measurably worse in
SmartScreen's heuristics, and the Properties → Details tab is the first place
a suspicious teammate looks. It is a console app rather than WinForms, so it
cannot silently do nothing, and it is not packed or obfuscated, both of which
are AV triggers. None of that is a substitute for signing.

The `/enroll` page carries this warning next to the download button.

## 1c. Why the `.exe` usually is not there, and what happens then

`SentinelSetup.exe` is compiled by `csc.exe` — the C# compiler inside the
.NET Framework, present on every Windows 10/11 machine and needing no SDK.
Render builds on Linux, where there is no `csc.exe`, and the binary is
**deliberately not committed**: it could never be rebuilt or verified at
deploy time, so it would be an opaque, unsignable blob in git forever that
launches PowerShell. The full argument, and what to change if you disagree,
is in [`installer/README.md`](../installer/README.md#why-the-exe-is-not-in-git).

The consequence is handled rather than hidden:

- `GET /v1/enroll` reports an `available` flag per launcher.
- `/enroll` renders each download button **only when the hub says it has the
  file**. On Render the page shows the `.cmd` and no `.exe` button. On a
  Windows-hosted hub where somebody has run `installer\build.ps1`, both.
- `GET /v1/enroll/installer/SentinelSetup.exe` returns `503
  installer_unavailable` with an `alternatives` object naming the `.cmd` URL
  and the one-liner, so anybody hitting the URL directly is not left at a
  dead end.

The `.cmd` is committed, so it is always served.

---

## 2. Why the scripts come from the control plane and not from GitHub

They used to come from `raw.githubusercontent.com`. Three reasons they no
longer do, in the order they matter:

1. **One origin.** The laptop has to reach the control plane anyway — that is
   where its heartbeats go. Serving enrollment from the same host means one
   firewall rule, one DNS name and one thing to be up, instead of two.
2. **The scripts match the deployment.** `/v1/enroll/*.ps1` is read off the
   checkout the running control plane was deployed from. `raw.../main/...` is
   whatever is on `main`, which is not the same thing the moment a deploy lags
   a merge.
3. **It survives the repo going private.** It *was* private until recently,
   and while it was, the documented one-liner 404'd on every teammate's
   laptop — as did the `git clone` that `bootstrap.ps1` then attempted. Two
   accounts and two permission systems had to line up before anyone could
   install anything. That failure mode is now gone regardless of what the
   repo's visibility does next.

---

## 3. Two paths for the code, and when each applies

`bootstrap.ps1` itself is always fetched from the control plane. The **repo**
it installs from has two sources:

| | Source | When | Needs |
|---|---|---|---|
| **Default** | `git clone https://github.com/imodoiepale/it-sentinel.git` | normal case; repo is public | git (installed automatically), github.com reachable |
| **Fallback** | `GET /v1/enroll/repo.zip` | clone failed, or `-UseControlPlane` | nothing but HTTPS to the hub |

git is the default because the repo is public and a clone is the plainest
thing that works: it leaves a real working copy that can be `git pull`ed,
`git log`ged and `git diff`ed afterwards, which an unpacked archive cannot.

The archive is the answer to **a network that blocks github.com** — locked-down
venue or corporate wifi is the realistic case, and it is one the demo cannot
afford to lose a laptop to. The fallback is automatic: a failed clone prints a
warning, cleans up its partial directory, and carries on with the download.
`-UseControlPlane` skips straight to it when you already know GitHub is
unreachable, and needs no git at all.

There is a third path that needs no network whatsoever: run
`scripts\bootstrap.ps1` from a copy of the repo on a USB stick or a file
share. It notices it is already inside a checkout and installs from it.

### Why the archive is a zip of the repo, not four loose .ps1 files

`install-sentinel-agent.ps1` is not standalone. It runs `pnpm install` at the
repo root and starts the agent from source under `apps/agent-node`. Fetching
the four scripts one at a time would get a laptop three steps into an install
before it discovered there was nothing to install.

The archive is **not** the whole checkout. It carries the workspace root,
`apps/agent-node`, `packages/contracts`, `packages/scripts` and `scripts/` —
and nothing else. The console source, the database migrations and these docs
have no business on a branch laptop, and shipping the smallest thing that
works keeps the route from quietly becoming a public mirror of the repo.
`node_modules`, `dist`, `.git`, **`.env` and `.env.local`** are excluded
everywhere they appear; a working checkout can hold real credentials in
`apps/agent-node/.env`, and shipping that would hand them to everyone who
enrolls. There is a test for it.

Zip rather than tar.gz because `Expand-Archive` ships with Windows PowerShell
5.1 on every machine we will ever meet, while `tar.exe` only arrived in
Windows 10 1803. It is built by hand from `zlib` (see
`apps/control-plane/src/enroll/repo-archive.ts`) rather than by adding a
dependency.

---

## 4. The routes

All under `apps/control-plane/src/enroll/`, registered by
`registerEnrollRoutes(app)` in `main.ts`.

| Route | Returns |
|---|---|
| `GET /v1/enroll` | self-describing JSON: the one-liner, the script URLs, the archive URL |
| `GET /v1/enroll/branches` | the seven enrollable branches, for the page's picker |
| `GET /v1/enroll/repo.zip` | the trimmed repo archive (§3) |
| `GET /v1/enroll/bootstrap.ps1` | `text/plain` |
| `GET /v1/enroll/install-sentinel-agent.ps1` | `text/plain` |
| `GET /v1/enroll/preflight.ps1` | `text/plain` |
| `GET /v1/enroll/uninstall-sentinel-agent.ps1` | `text/plain` |
| `GET /v1/enroll/installer/SentinelSetup.cmd` | the batch launcher, as an attachment |
| `GET /v1/enroll/installer/SentinelSetup.exe` | the compiled launcher, or `503` (§1c) |

`text/plain` and not JSON on purpose: `Invoke-RestMethod` parses by content
type, and `irm … | iex` needs a string.

The two launcher routes always send `Content-Disposition: attachment`. A
browser that renders a `.cmd` inline hands somebody a page of text with no
obvious way to save it, and one that decides to *run* a downloaded `.exe` on
its own is a category of surprise these routes should not be capable of
causing. The `.cmd` is also **re-line-ended to CRLF on the way out** — not
cosmetic, because `cmd.exe` mis-parses `goto` labels and parenthesised blocks
in a bare-LF file and that launcher uses both, and git is entitled to
normalise the working tree on the Linux checkout Render serves from.

**`/v1/enroll/branches` returns exactly the seven slugs that
`install-sentinel-agent.ps1` accepts**, not every row in `sites`. The
installer hard-rejects any other slug and exits, so a picker offering the 44
seeded Kenyan branches would hand people a command that cannot work. The two
lists are duplicated deliberately and both trace back to
`packages/db/seed/003_bootstrap_demo.sql`; if that seed changes, both change.
If the database is unreachable the route answers from its own constant rather
than 500ing — a Supabase blip should not be the reason nobody can enroll.

### Path traversal

These routes read files off the server's disk for unauthenticated callers.
A traversal here reads anything the process can read, `.env` included.

The defence is that **no caller-supplied string ever reaches the
filesystem**. The `:file` parameter is tested for membership in a four-entry
`Set`, and it is the matched *constant* that gets joined onto the path. That
closes the whole class — `..%2f..%2f.env`, `%2e%2e%2f`, `C:\Windows\win.ini`,
a NUL-truncated name, a case variant — without anyone having to enumerate it.
A second check that the resolved path is still inside `scripts/` is there as
defence in depth, unreachable today, and kept because the allowlist being
loosened later is the failure that would matter.

`/v1/enroll/installer/:file` works the same way, with its own `Map` and its
own set of constants. It is the more tempting target of the two, being the
one that reads outside `scripts/`.

`apps/control-plane/test/enroll.routes.test.ts` exercises ten traversal
shapes against the scripts route plus a real-but-not-allowlisted file
(`simulate-fault.ps1`), and thirteen against the installer route — including
the one that matters most, that `/v1/enroll/installer/bootstrap.ps1` is a
`404`, so the two allowlists cannot quietly merge into one servable
directory. It also asserts that an unknown name gets `404` and not the `503`,
even on a deployment with no `installer/` at all: allowlist first, disk
second, or the `503` becomes an oracle for which paths exist on the server.
All of it goes through Fastify's router rather than the handler, because URL
decoding is part of what is being tested.

---

## 5. Security

### 5.1 What is behind login, and what is not

**The `/enroll` page is behind operator login.** The `/v1/enroll/*` routes are
not. That split is deliberate.

The routes serve non-secret text. Every one of those `.ps1` files is in a
public repo; the archive is a subset of the same. There is no credential in
any of it — the hub URL is public, the branch slug is public, and the VNC
password is typed by the person at the keyboard and never travels through
here. Putting a token in front of a URL that has to be pasteable into a blank
PowerShell window, on a machine with nothing installed on it and no way to
present a credential, would buy no confidentiality and cost the entire
premise.

The page is gated anyway, because it is not the *scripts* that are worth
knowing — it is the combination of which branch slugs exist and which hub to
point at. That is precisely the reconnaissance needed to exercise the gap in
§5.2, and there is no reason to publish it.

### 5.2 Known limitation: `POST /v1/heartbeat` has no authentication

**State it plainly: any machine on the internet that posts a well-formed
heartbeat naming an existing branch slug is auto-provisioned into the
fleet.** `ingest.service.ts` creates the `assets` row on first sight of an
unknown hostname; there is no token, no shared secret and no approval step.
The row lands with an `asset.auto_provisioned` audit entry and then appears in
the console like any other machine.

This is not new, and the enrollment page does not create it. What the page
does is make it materially easier to *discover*: it publishes the hub URL and
the exact set of valid slugs in one place. Gating the page behind operator
login is a speed bump on that discovery, not a fix.

What it is not: a remote-control hole. A rogue machine that provisions itself
cannot *dispatch* anything — `POST /v1/commands` runs through
`evaluateCommandPolicy`, which needs an operator with a `site_access` grant —
and it cannot open a VNC session to a real laptop. The damage is noise in the
fleet and, if someone crafted the payload for it, false alerts.

Be precise about the blast radius, though: the agent-facing routes next to it
(`GET /v1/commands/poll?assetId=…` and `POST /v1/commands/:msgId/result`) have
no authentication either, and take the asset they act on straight from the
request. So the same caller could drain another machine's command queue or
report a fabricated result for one. Any fix worth doing has to gate all three
routes with the same per-machine credential, not just the heartbeat.

**The real fix, in shape:**

1. `/enroll` issues a short-lived, single-use **enrollment token** bound to
   the chosen branch — minted server-side, recorded, attributable to the
   operator who generated it.
2. The generated one-liner carries it; `install-sentinel-agent.ps1` writes it
   into `apps/agent-node/.env` alongside the hub URL.
3. The agent's **first** heartbeat presents the token. `ingest.service.ts`
   auto-provisions only on a valid unused token, burns it, and issues the
   machine a long-lived per-asset credential for subsequent heartbeats.
4. A heartbeat for an unknown asset with no token becomes a `401`, not a new
   row — and `/v1/commands/poll` and `/v1/commands/:msgId/result` check the
   same per-asset credential against the `assetId` they were handed.

That is a schema change (`enrollment_tokens`, plus a credential column on
`assets`), a change to `ingest.service.ts`, and a change to the agent — three
files this work does not own and a migration nobody should be writing hours
before a demo. It is written down here so it is a decision rather than an
oversight.

### 5.3 What the page tells people, honestly

`/enroll` summarises what the installer does — Node, PowerShell 7, Git,
Chrome, TightVNC, inbound TCP 5900, a scheduled task — and says in as many
words that **an operator can watch and control the desktop**, that every
session is audit-logged against a named operator, and that a personal laptop
somebody would not want watched should not be enrolled.

It summarises rather than duplicates. The installer's own on-screen
disclosure is the authoritative one, and the page says so: two copies of the
same text drift, and the one that drifts is always the one nobody has to type
`INSTALL` under.

---

## 6. Operating it

| Variable | Where | Why |
|---|---|---|
| `SENTINEL_REPO_ROOT` | control plane | override for finding the checkout. Only needed if a deployment moves the app away from the repo it was built from; the routes return `503` with that message rather than a confusing `404` when the checkout cannot be found. |
| `CONTROL_PLANE_PUBLIC_URL` | control plane | the URL printed in `GET /v1/enroll`. Falls back to the `Host` header, which is right in every deployment we have. |
| `NEXT_PUBLIC_CONTROL_PLANE_URL` | web console | the hub baked into the generated command. **If this is wrong, every command the page emits points at the wrong hub.** |

The archive is built once, on the first request, and cached for the life of
the process — Render redeploys rather than mutating a working tree, so it
cannot go stale under a running server. A redeploy rebuilds it.

### Troubleshooting

| Symptom | Cause |
|---|---|
| One-liner returns `503 script_unavailable` | the control plane cannot find its checkout. Set `SENTINEL_REPO_ROOT`. |
| One-liner hangs ~50s then works | free-tier host waking from idle. Not a fault. |
| `Could not clone …` then it carries on | expected. github.com is unreachable; the archive fallback took over. |
| `… already exists, has files in it, and is not an IT Sentinel copy` | something else is at `%USERPROFILE%\it-sentinel`. Move it, or pass `-InstallRoot C:\it-sentinel`. |
| Machine installs but never appears | wrong `-ControlPlaneUrl`, or the branch slug was rejected. Run `scripts\preflight.ps1`. |
| No `.exe` download button on `/enroll` | expected on the hosted hub. The binary is not committed (§1c). Use the `.cmd`. |
| `503 installer_unavailable` | same cause. The response names the `.cmd` URL and the one-liner. |
| "Windows protected your PC" on the `.exe` | expected, it is unsigned. **More info** → **Run anyway** (§1b). |
| The `.exe` disappears from Downloads | AV quarantined it. Nothing to click. Use the `.cmd`. |
| `.cmd` opens in Notepad instead of running | the browser saved it as `.txt`. Rename it back to `.cmd`, or use the one-liner. |

---

## 7. See also

- [`installer/README.md`](../installer/README.md) — the two launchers, building the exe, and the signing problem
- [15 — Hackathon demo runbook](./15-hackathon-demo-runbook.md) — the manual path this replaces
- [18 — Decommissioning](./18-decommissioning.md) — the way back out
- [05 — Security model](./05-security-model.md)
