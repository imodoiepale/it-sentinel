# 14 — Status and Roadmap

The honest state of the system, as of this writing. Nothing in this document is aspirational — "built" means built and passing tests; "stubbed" means real code that intentionally stands in for something not yet attached; "not started" means exactly that.

## Built, tested, and verified

- **Shared contract** (`packages/contracts`) — the wire schema every collector and the control plane agree on. 4/4 tests.
- **Database schema** — 24+ migrations applied live, 44 branches seeded, RLS proven with real transaction-level tests (6/6), Realtime publication confirmed to contain exactly the 4 intended tables, the credential vault's decrypt path confirmed grant-restricted to `service_role` only.
- **Control plane** (`apps/control-plane`) — ingest, session broker, orchestrator, policy, ticket intelligence, morning report, WhatsApp client (honestly no-ops without real credentials), in-process daily digest scheduler. 7/7 tests, clean typecheck.
- **`agent-node`** — the LocalSystem collector and the security-critical elevated executor. **26/26 adversarial tests**, including all 16 T6 attack patterns, 3 hash-tampering scenarios, and a proven-inert prompt-injection payload. Real `node-windows` service installer, never run against a real machine.
- **`agent-less`** — real PowerShell-remoting collector giving day-one coverage to all 44 branches without installing anything. 2/2 tests.
- **The relay** (`apps/relay`) — clean-room RFB 3.8 handshake and VNC-auth DES from RFC 6143, a real Node stream bug found and fixed during development, 16/16 tests including a full mock-server handshake state machine.
- **The Sentinel Agent harness** (`apps/sentinel-agent`) — the cage built and adversarially tested before any model was attached, exactly per the plan's discipline. **21/21 tests** (14 adversarial + 7 proving the DeepSeek client contract).
- **The web console** (`apps/web`) — auth, branch sidebar, fleet table, voice with live-verified branch resolution, the 13-tab Machine Workspace with Remote Desktop and Terminal genuinely wired to real backends. Clean `next build`.
- **The script library** — 8 real, hash-verified, seeded playbooks across printer/network/Enquest/Windows/security.

**76/76 tests passing across the whole workspace.** Every number above is traceable to an actual test run, not a description — see [12-testing-and-verification.md](./12-testing-and-verification.md) for exactly what each suite proves.

## Stubbed — real code, deliberately standing in for something not yet attached

- **`sentinel-agent`'s default `StubPlanner`** — a fixed pattern-matcher. `DeepSeekPlanner` (a real client against DeepSeek's documented tool-calling contract) exists and is tested, but is opt-in via `DEEPSEEK_BASE_URL` and has never run against a live endpoint. See [10-sentinel-agent.md](./10-sentinel-agent.md).
- **WhatsApp notifications** — a genuine, correctly-shaped client against Meta's documented Cloud API. No-ops with a clear log line when `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` aren't set, rather than pretending to send.
- **`agent-dotnet`** — a real, never-compiled Worker Service skeleton. The .NET 8 SDK is not installed in this environment; this is stated plainly in `apps/agent-dotnet/README.md` rather than presented as working.

## Not started

- **The thumbnail/monitoring-wall sampler** in the relay (the MightyViewer-style live-preview grid).
- **Session recording** — the `sessions.recording_ref` column exists; nothing writes to it.
- **The Go port of the relay** (planned only for thumbnail-wall load at higher scale; not needed at 44 branches).
- **RAG over `knowledge`** — the table and its pgvector index exist; nothing populates or queries them.
- **T3+ (write) tools for the Sentinel Agent** — deliberately deferred past this build phase.
- **Eleven of the thirteen Machine Workspace tabs** (Files, Processes, Services, Printers, Network, Logs, Enquest, Software, Security, Tickets, History) — present as navigation, not wired to data yet, even though the underlying `telemetry`/`checks`/`incidents` data already exists to build them from.
- **A console UI for asking the Sentinel Agent a question** — the backend endpoint works; nothing calls it from `apps/web` yet.
- **A local dev stack** (`infra/docker-compose.yml`) — development currently happens against the live Supabase project directly.
- **Any real deployment** — see [13-deployment.md](./13-deployment.md).
- **Camera/CCTV, network-device (switch/AP/UPS), and the other ~15 of the "20 additional monitored services" from the original plan** — the `assets.asset_type` discriminator was built specifically so these slot in without a schema migration, but no collector for any of them exists yet.

## Known, accepted residual findings

- Two `pgaudit` internal trigger-handler functions can't have their PostgREST `EXECUTE` grants revoked from this session's role (owned by `supabase_admin`) — low real risk (event-trigger handlers, not data-exposing), documented rather than silently left unmentioned. See [04-database.md](./04-database.md).
- `pg_trgm`, `vector`, and `pgaudit` remain installed in the `public` schema rather than a dedicated one (a cosmetic Supabase advisor WARN) — moving them now risked regressing objects that already depend on them, for no functional gain.

## If you're picking this up next, roughly in order of leverage

1. **Populate real assets** for the other 43 branches (currently only Junction Mall has one, and it's a placeholder) — either by running `agent-less` for real against actual branch IPs, or by seeding `assets` rows by hand for testing.
2. **Get one real remote session working end-to-end** against an actual TightVNC Server — this is the single biggest "does this actually work" proof point that hasn't been done yet.
3. **Wire the remaining Machine Workspace tabs** to the telemetry/checks data that already exists.
4. **Build the console UI for `/v1/ask`** — the Sentinel Agent backend is ready and tested; it just isn't reachable from the UI yet.
5. **Install the .NET SDK and pick up `agent-dotnet`** if native fidelity beyond PowerShell shell-out becomes a priority.
6. **Attach a real DeepSeek endpoint** once the read-only harness has had real-world exposure.
