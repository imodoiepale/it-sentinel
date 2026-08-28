# 02 — Getting Started

## Prerequisites

| Tool | Confirmed present in the reference dev environment |
|---|---|
| Node.js | 26.7.0 |
| pnpm | 9.12.0 (pinned in `package.json`'s `packageManager` field) |
| PowerShell 7 (`pwsh`) | Required for `agent-node`/`agent-less` collection and the relay's session flow indirectly |
| .NET 8 SDK | **Not installed.** Only needed if you're picking up `apps/agent-dotnet` — see [14-status-and-roadmap.md](./14-status-and-roadmap.md) |
| Go | **Not installed.** Only needed for the future Go port of the relay under heavy thumbnail-wall load — not required for anything that exists today |

## 1. Install workspace dependencies

```bash
pnpm install
```

This installs all ten workspace packages in one pass (`pnpm-workspace.yaml` covers `apps/*` and `packages/*`).

## 2. Get access to the Supabase project

The live project is **`IT COMMAND CENTER`** (`ncyerayycwkqytznnkrs`, `eu-central-1`). You need:

- The **project URL**: `https://ncyerayycwkqytznnkrs.supabase.co`
- The **publishable/anon key** (safe to put in frontend `.env` files — it's RLS-constrained, not a secret)
- The **service-role key** (a real secret — never commit it, never paste it into chat, never let it reach the browser). Get it from the Supabase dashboard: Project Settings → API → service_role secret key.

## 3. Set up environment files

Every app that needs configuration ships a `.env.example` — copy it to `.env` (already gitignored) and fill in the blanks.

```bash
cp apps/control-plane/.env.example apps/control-plane/.env      # needs SUPABASE_SERVICE_ROLE_KEY
cp apps/agent-less/.env.example apps/agent-less/.env
cp apps/agent-node/.env.example apps/agent-node/.env
cp apps/relay/.env.example apps/relay/.env                      # needs SUPABASE_SERVICE_ROLE_KEY
cp apps/sentinel-agent/.env.example apps/sentinel-agent/.env
cp apps/web/.env.example apps/web/.env.local                    # publishable key only, safe for the browser
```

**Never put the service-role key in `apps/web`'s env file.** The browser only ever gets the publishable key.

## 4. Run the pieces you need

Each app is independent; you don't need all of them running to work on one.

```bash
# Control plane — the API every collector and the console talk to
cd apps/control-plane && pnpm start        # tsx src/main.ts, listens on :8787

# Web console
cd apps/web && pnpm dev                    # next dev, listens on :3000 (or pass -p)

# A telemetry collector — agent-less needs no install on the branch machine
cd apps/agent-less && pnpm start

# The remote-access relay
cd apps/relay && pnpm start                # listens on :8788

# The Sentinel Agent (AI harness, stub planner by default)
cd apps/sentinel-agent && pnpm start       # listens on :8789
```

## 5. Create your operator account and grant yourself access

The console shows **zero branches** to a signed-in user with no `site_access` row — that's RLS working correctly, not a bug. To see data:

1. Create a user via Supabase Auth (dashboard → Authentication → Users → Add User, or `supabase.auth.admin.createUser` from a service-role context).
2. Grant yourself a role on one or more sites:
   ```sql
   insert into public.site_access (operator_id, site_id, role)
   values ('<your-auth-user-id>', (select id from public.sites where slug = 'junction-mall'), 'it_manager');
   ```
3. Sign in at `/login` in the web console.

## 6. Run the test suite

Every package with real logic has real tests — this isn't optional scaffolding, it's how several genuine bugs in this codebase were caught (see [12-testing-and-verification.md](./12-testing-and-verification.md)).

```bash
# One package
cd apps/agent-node && pnpm exec vitest run

# Everything (from repo root)
for pkg in packages/contracts apps/control-plane apps/agent-less apps/agent-node apps/relay apps/sentinel-agent; do
  (cd "$pkg" && pnpm exec vitest run)
done
```

## 7. Typecheck and build

```bash
# Any TS package
cd apps/control-plane && pnpm exec tsc -p tsconfig.json --noEmit

# The web app (includes typecheck + Next.js build)
cd apps/web && pnpm exec next build
```

## What you can't do without more setup

- **See a real remote desktop session** — needs a real branch machine running TightVNC Server, a `credentials` row created via `store_credential()`, and an `assets` row pointing at it with a `vnc_port`.
- **Run `agent-dotnet`** — the .NET 8 SDK isn't installed; see [14-status-and-roadmap.md](./14-status-and-roadmap.md).
- **Get a real AI answer** — `sentinel-agent` ships with `StubPlanner`, a fixed pattern-matcher, not a real model. See [10-sentinel-agent.md](./10-sentinel-agent.md) for what swapping in DeepSeek actually involves.
- **Receive a WhatsApp message** — `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` aren't set; the notify module logs what it *would* send instead of pretending to send it.
