# 09 — Web Console

Next.js 15 App Router, `apps/web`. Dark-themed, built for a NOC-style overview.

## Screens and components

| File | What it is |
|---|---|
| `app/login/page.tsx` | Supabase Auth email/password sign-in |
| `app/page.tsx` | The Command Center — sidebar, fleet table, voice bar, machine workspace trigger |
| `components/BranchSidebar.tsx` | Replaces the old IP-address list — grouped branches, status dot, machine/region counts, click to filter |
| `components/FleetTable.tsx` | Branch · PC · Network · Email · Printer · Enquest · Security · RAM · Disk · VNC — sortable, "only show what's broken" filter defaulted **on** |
| `components/StatusDot.tsx` | The one place status color is rendered — `healthy`/`warning`/`critical`/`stale`/`unknown`, always with an accessible label, `stale` never collapsed into `healthy` |
| `components/VoiceBar.tsx` | Push-to-talk, Web Speech API, branch resolution, ambiguity confirmation |
| `components/MachineWorkspace.tsx` | The 13-tab panel — Remote Desktop, Terminal, Files, Processes, Services, Printers, Network, Logs, Enquest, Software, Security, Tickets, History |
| `components/TerminalPanel.tsx` | Dispatches `adhoc_powershell` commands through the real orchestrator; T3 commands require in-UI confirmation before dispatch |
| `components/viewer/NoVncCanvas.tsx` | The noVNC binding — see [08-relay-and-remote-access.md](./08-relay-and-remote-access.md) |
| `lib/useAuth.ts` | Thin wrapper over Supabase Auth session state |
| `lib/useFleet.ts` | Loads the operator's RLS-scoped branch/asset tree, keeps it live via `lib/realtime.ts` |
| `lib/realtime.ts` | **The one Realtime subscription in the app** — exactly the 4 tables in the publication |
| `lib/supabase.ts` | The browser-side client, scoped to the **publishable key only** — never the service-role key |

## Why the fleet shows zero branches by default

If you sign in with an operator who has no `site_access` rows, the console correctly shows nothing at all. This is Row Level Security working, not a bug — see [04-database.md](./04-database.md) and [02-getting-started.md](./02-getting-started.md) for how to grant yourself access.

## Voice

`VoiceBar.tsx` uses the Web Speech API (`window.SpeechRecognition`/`webkitSpeechRecognition`) for push-to-talk. On a transcript:

1. Strips a leading `"open "` if present.
2. Calls the `resolve_branch_by_voice` RPC (`pg_trgm` similarity over `sites.name` and `voice_aliases`, `SECURITY INVOKER` so RLS still applies — an out-of-scope branch never resolves).
3. If the top match beats the second by more than 0.25 similarity, opens it directly.
4. Otherwise, surfaces the top two as a "Did you mean..." confirmation — this is exactly the case for the deliberately-seeded ambiguous pairs: Sarit Centre / Sarit Centre Annex / City Brands-Sarit, Nyali A / B / Bazaar, Runda Main / Perfume, Westend / Perfume, Junction Mall / Store.

Verified live against the real database (see [12-testing-and-verification.md](./12-testing-and-verification.md)): "sarit" resolves to Sarit Centre at similarity 1.0 vs. City Brands-Sarit at 0.35; "nyali b" resolves to Nyali B at 1.0 vs. its siblings at 0.5–0.6.

Any action at T3 or above triggered via voice still goes through the same confirmation flow as the console UI — voice never fires a remediation command directly off a transcript.

## The Machine Workspace

Opens as a modal over the fleet view, either by clicking a row in `FleetTable` or via voice. Two of the thirteen tabs are wired to real backends today:

- **Remote Desktop** — requests a session via `POST /v1/sessions`, renders the result in `NoVncCanvas`. "Start Remote Session" (control) or "View Only" — the operator explicitly picks the mode.
- **Terminal** — dispatches through `POST /v1/commands`. T2 (diagnose) commands go straight through; T3 (remediate) commands show a confirmation card (device, command, tier, risk) before dispatch, mirroring the plan's "Proposed action... [Run] [Cancel]" pattern. This is a UI-level convenience — the real enforcement is `agent-node`'s executor, which checks independently regardless of what the UI did.

The remaining eleven tabs (Files, Processes, Services, Printers, Network, Logs, Enquest, Software, Security, Tickets, History) are present as navigation with placeholder content — the data they'd render already exists in `telemetry`/`checks`/`incidents`, but the views themselves aren't built yet.

## Realtime, precisely

`useFleet.ts` opens exactly one `supabase.channel()` (via `subscribeToFleetUpdates` in `lib/realtime.ts`), listening to `postgres_changes` on `asset_health`, `alerts`, `incidents`, and `sessions`. Any change triggers a full `reload()` of the branch tree rather than a granular patch — simpler, and fine at the current data volume; a future optimization would patch the affected row directly instead of refetching everything.

## Known gaps

- No dedicated executive/NOC-density view toggle (the plan describes both a dense operator view and a simplified executive summary).
- No dark/light theme switch — the console is dark-only.
- No mobile-responsive layout pass.
- `MachineWorkspace`'s eleven placeholder tabs.
- No session-recording playback UI (the backend column exists; nothing writes to it yet).
