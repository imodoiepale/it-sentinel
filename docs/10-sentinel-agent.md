# 10 — Sentinel Agent (AI Harness)

## The one rule that matters: the model never executes anything

`apps/sentinel-agent` is a tool-calling harness. Whatever produces a question's answer — today a fixed pattern-matcher, eventually a real language model — only ever emits a **`ToolCall`**: a tool name and arguments. It never touches a database connection, never runs a query, never decides on its own what it's allowed to do. A separate **executor** (`src/executor.ts`) validates that call against a **guard** (`src/policy/guard.ts`) before anything runs. This mirrors `agent-node`'s elevated-execution model exactly, and is described in [05-security-model.md](./05-security-model.md).

A model attached to this harness — even a jailbroken one, even one convinced by a cleverly-worded prompt that it should help with something forbidden — **cannot** do anything on the T6 list or reach a tool that doesn't exist, because it never held that capability. The security boundary is code, not instructions.

## Why the harness comes before the model, deliberately

Per the plan's explicit build-order discipline: build the executor, the tier resolver, and the deny-list logic with a **stub** model first, assert every boundary holds adversarially, and *only then* attach a real model — starting with T0–T2 read-only tools, with T3+ write tools added later, separately, after the read-only path has run clean in practice. This build followed that order. `StubPlanner` (`src/planner.ts`) is the stub; nothing more capable has been attached yet, and that's intentional, not an oversight.

## The tool registry — what actually exists today

`apps/sentinel-agent/src/tools/registry.ts` — **five tools, all T0/T1, all read-only:**

| Tool | Tier | What it returns |
|---|---|---|
| `get_asset_health` | T0 | Current health snapshot for one machine |
| `get_fleet_status` | T0 | Fleet-wide or single-branch health summary |
| `get_recurrence` | T0 | How many times a fault has recurred, and what fixed it last time |
| `list_incidents` | T0 | Open/historical incidents, filterable by branch and status |
| `get_check_history` | T1 | Recent diagnostic results for one machine |

**There is no `restart_service`, no `run_command`, no write tool of any kind.** This is not a limitation to work around — it's the whole point of this build phase. A fabricated tool call naming something higher-tier (`restart_service`, `delete_asset`, `reboot_machine`, `grant_access`) is refused as `unknown tool`, because the registry genuinely has nothing by that name for the executor to find.

Each tool declares, statically, its own tier and the exact tables it's allowed to touch (`allowedTables`) — the guard cross-checks this against a T6-table denylist (`credentials`, `_session_tokens`, `audit_log`, `vault.secrets`, `vault.decrypted_secrets`) independently of what the tool's implementation actually does, so a bug in one doesn't silently widen access.

## The guard — `src/policy/guard.ts`

Runs before any tool call reaches its implementation, in order:

1. **Unknown-tool / T6-table check** — is this a real registered tool, and does it declare access to anything on the denylist?
2. **Role-vs-tier ceiling** — using the same `RoleTierCeiling` from `packages/contracts` that `agent-node` uses.
3. **Deny-pattern scan of the arguments themselves** — `scanArgsForDenyPatterns()` JSON-stringifies the args and checks against a subset of the shared `T6_DENY_PATTERNS`, catching an attempt to smuggle something like `vault.decrypted_secrets` into a legitimate tool's string argument.

Then, in `executor.ts`, **site-scope enforcement**: any argument named `assetId` or `siteSlug` is resolved to a site, and if that site isn't in the operator's `site_access` grants, the call is refused before any query executes — never after.

## Proven, not just described

`apps/sentinel-agent/test/executor.adversarial.test.ts` — **14/14 passing:**

- All 5 fabricated high-tier tool calls refused as unknown tools, none reaching the database client
- A fabricated T6-table tool call (`get_vault_secret`) refused before `db.from()` is ever invoked
- A deny-pattern payload embedded in a legitimate tool's `siteSlug` argument caught and refused
- An `auditor` role (capped at T0) allowed a T0 tool, refused a T1 tool
- Cross-site asset access refused, and refused again when the asset resolves to no site at all
- Malformed arguments refused by schema validation before any query runs
- Every refusal audited exactly once, every success audited exactly once, never confused

## The HTTP entry point

`apps/sentinel-agent/src/main.ts` — `POST /v1/ask`, body `{ question, operatorJwt }`. Critically, the **operator's own JWT** builds the Supabase client used for every query in that request, never a service-role key. Even if `executor.ts` or `guard.ts` had an undiscovered bug, Row Level Security on every table this agent touches is a second, fully independent boundary — the agent's effective database access can never be wider than the operator's own.

## `DeepSeekPlanner` — a real client, built against DeepSeek's actual documented contract

`src/deepseek-planner.ts` exists and is tested (7/7, `test/deepseek-planner.test.ts`), but is **not the default** — `main.ts` only uses it when `DEEPSEEK_BASE_URL` is explicitly set; otherwise `StubPlanner` runs, unconditionally. This was built after researching DeepSeek's real API docs and vLLM's actual DeepSeek tool-call-parser implementation, not guessed:

- **The contract**: DeepSeek's hosted API (`api-docs.deepseek.com/guides/function_calling`, `/guides/tool_calls`) and self-hosted open weights served via vLLM/Ollama (`--tool-call-parser deepseek_v3` or `deepseek_v31`) both normalize to the same **OpenAI-compatible tool-calling JSON shape** — `POST {baseUrl}/chat/completions` with a `tools` array and `tool_choice: "auto"`, returning `choices[0].message.tool_calls[0].function.{name, arguments}`. DeepSeek's own models natively emit a different markup internally (DSML, `<｜DSML｜tool_calls>`) but vLLM's parser handles that translation server-side — the client (this harness) never has to speak DSML itself.
- **The tool schemas are generated, not hand-written twice.** `src/tools/openai-schema.ts` converts each tool's real `argsSchema` (Zod) into the JSON Schema DeepSeek's `tools` array expects, via `zod-to-json-schema` — so the schema advertised to the model and the schema the executor actually enforces can never silently drift apart.
- **DeepSeek's own documented caveat is honored, not just noted**: "Generated tool arguments may not always be valid JSON and should be validated before your application calls the function." `deepseek-planner.ts` `JSON.parse`s the arguments defensively and falls back to a clarification response on failure — the executor's Zod validation is the second, authoritative check regardless.
- **A real, documented vLLM failure mode is handled**: their own issue tracker reports DSML tool-call markup sometimes leaking into `content` or vanishing entirely under thinking mode instead of producing a structured `tool_calls` entry. The planner treats *any* response without a clean `tool_calls` array as "no tool call, ask for clarification" — it never tries to regex-recover a tool call out of raw leaked text, because that would mean trusting unparsed model output as if it were the actual API contract.
- **What doesn't change, regardless of which planner runs**: the model's output is still only ever a proposed `ToolCall`. `executor.ts` and `guard.ts` re-validate everything downstream exactly the same way whether it came from `StubPlanner` or `DeepSeekPlanner` — a hallucinating or adversarially-prompted model still can't reach a tool that doesn't exist or a site outside the operator's scope, because it never held that capability to begin with.

## What's still required before this touches real traffic

1. **Harness + tools + RAG** (what's built here, plus retrieval over `knowledge`) — the harness and the DeepSeek client itself are done and tested; RAG over `knowledge` is not (see below).
2. **A real endpoint** — `DeepSeekPlanner` has never been run against a live DeepSeek API key or a real vLLM/Ollama deployment; only against a mocked `fetch` proving the request/response contract is correct.
3. **LoRA fine-tune** on your own resolved-ticket history, once a few thousand good examples exist — teaches house conventions, branch naming, Enquest specifics. Worth doing later; no schema changes needed to start.
4. **Full fine-tune / continued pretraining** — months, real GPU spend, unlikely to beat (1)+(3) for this scope. Not planned.

Flipping from `StubPlanner` to `DeepSeekPlanner` in production is setting one environment variable (`DEEPSEEK_BASE_URL`) — deliberately not automatic, so a deployment never starts sending real questions to a real model just because a key happened to be present somewhere.

## What's not built

- **RAG over `knowledge`** — the table and its `pgvector` HNSW index exist; nothing populates or queries it yet.
- **T3+ write tools** — deliberately not added yet; see the build-order discipline above.
- **A console UI panel for asking the agent a question** — the `/v1/ask` endpoint exists and works; nothing in `apps/web` calls it yet.
- **A live endpoint actually running `DeepSeekPlanner`** — the client code, its request/response contract, and its documented failure-mode handling are built and tested (7/7); it has never been pointed at a real API key or a real vLLM/Ollama deployment, and `StubPlanner` remains the default unless `DEEPSEEK_BASE_URL` is explicitly set.
