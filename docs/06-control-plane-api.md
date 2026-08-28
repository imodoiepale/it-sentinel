# 06 — Control Plane API Reference

Base implementation: `apps/control-plane/src/main.ts` (Fastify). Default port `8787` (`PORT` env var). All bodies are JSON.

## `POST /v1/heartbeat`

Every collector posts here — `agent-node`, `agent-less`, and (once built) `agent-dotnet` all use this identical endpoint with the identical `HeartbeatPayload` shape from `packages/contracts/src/heartbeat.ts`.

| Response | Meaning |
|---|---|
| `200 { assetId, status }` | Accepted, health/telemetry/checks written |
| `400 { error: "invalid_heartbeat", issues }` | Failed Zod validation — never silently accepted |
| `404 { error: "unknown_asset", message }` | The *branch* doesn't exist (the asset itself auto-provisions on first heartbeat — see `ingest.service.ts`) |
| `500` | Unexpected error |

## `POST /v1/sessions`

The session broker. Body matches `SessionRequest` (`packages/contracts/src/session.ts`): `{ assetId, operatorId, ticketRef?, reason, mode: "view" | "control" }`.

Returns `201` with a `SessionGrant`: `{ sessionId, relayUrl, singleUseToken, expiresAt, mode, recorded: true }`.

**Never returns a credential.** `403 { error: "session_denied", reason }` if policy denies (no site access, or no credential configured for the asset).

## `POST /v1/sessions/:sessionId/end`

Body: `{ bytesTransferred: number, recordingRef?: string }`. `204` on success.

## `POST /v1/commands`

Dispatches an elevated command through the orchestrator — the one path into `pgmq`, used by the terminal UI, playbooks, and (eventually) voice, all identically.

Body:
```json
{
  "assetIds": ["uuid", "..."],
  "operatorId": "uuid",
  "ticketRef": "INC-1234",
  "kind": "adhoc_powershell",
  "adhocCommand": "Restart-Service -Name Spooler",
  "tier": "T3"
}
```

`kind` is one of `signed_script` (add `scriptId`, `scriptVersion`, `scriptSha256`), `adhoc_powershell` (add `adhocCommand`), or `service_action` (add `serviceName`, `serviceAction`).

Targeting more than 5 assets in one call automatically promotes the effective tier to `T5`, regardless of what was requested — the blast-radius rule from the security model.

`202 { commandIds: [...] }` on acceptance. `403 { error: "command_denied", reason }` if policy denies.

## `GET /v1/commands/poll`

Long-poll endpoint the agent's exec loop calls. Returns `{ messages: [{ msg_id, message: CommandRequest }] }`.

## `POST /v1/commands/:msgId/result`

The agent reports back here after `executor.ts` runs. Body is a `CommandResult` (`packages/contracts/src/command.ts`). `204` on success — this also acks the `pgmq` message.

## `GET /v1/tickets/recurrence?checkType=&assetId=&faultClass=`

Returns `{ timesSeen, similarIncidents, suggestedFix, successRatePercent }` — "seen 6 times, previous fix restart-spooler succeeded 92%."

## `POST /v1/alerts/:alertId/open-incident`

Converts an alert into an incident, attaching the recurrence report to the first `incident_events` row. `201 { incident, recurrence }`.

## `GET /v1/sites`

`{ sites: [{ id, name, slug, primary_ip, region, criticality }] }`. Exists specifically so `agent-less` can discover branch IPs without needing its own database credentials.

## `GET /v1/reports/daily`

`{ report: DailyReport, text: string }` — the morning report (see `apps/control-plane/src/notify/report.service.ts`), both as structured JSON and as the fixed-width text block from the plan.

## `POST /v1/reports/daily/whatsapp`

Body: `{ toE164: string }`. Generates the report and sends it via WhatsApp. `200 { sent: true }` if actually sent; `202 { sent: false, reason: "not_configured" }` if `WHATSAPP_ACCESS_TOKEN`/`WHATSAPP_PHONE_NUMBER_ID` aren't set — this endpoint never pretends to have sent something it didn't.

## `GET /healthz`

`{ status: "ok" }`. Liveness check.

## The daily digest scheduler

Not an HTTP endpoint — `apps/control-plane/src/notify/scheduler.ts` runs inside the same long-lived process, checking once a minute whether it's the configured UTC hour (`DAILY_DIGEST_HOUR_UTC`, default 5 ≈ 08:00 EAT) and hasn't already sent today. This exists *instead of* a `pg_cron` + `pg_net` job calling back into the control plane, because Supabase's cloud `pg_cron` cannot reach a `localhost` control plane — see [04-database.md](./04-database.md) and [14-status-and-roadmap.md](./14-status-and-roadmap.md) for the reasoning.
