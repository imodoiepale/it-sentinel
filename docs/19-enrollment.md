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

`text/plain` and not JSON on purpose: `Invoke-RestMethod` parses by content
type, and `irm … | iex` needs a string.

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

`apps/control-plane/test/enroll.routes.test.ts` exercises ten traversal
shapes plus a real-but-not-allowlisted file (`simulate-fault.ps1`), through
Fastify's router rather than by calling the handler, because URL decoding is
part of what is being tested.

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

---

## 7. See also

- [15 — Hackathon demo runbook](./15-hackathon-demo-runbook.md) — the manual path this replaces
- [18 — Decommissioning](./18-decommissioning.md) — the way back out
- [05 — Security model](./05-security-model.md)
