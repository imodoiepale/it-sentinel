import Fastify from "fastify";
import { db } from "./db.js";
import { env } from "./env.js";
import { HeartbeatValidationError, UnknownAssetError, ingestHeartbeat } from "./ingest/ingest.service.js";
import { requestSession, SessionDeniedError, endSession } from "./session/session.service.js";
import { dispatchCommand, pollCommands, reportCommandResult, CommandDeniedError } from "./orchestrator/orchestrator.service.js";
import { openIncidentFromAlert, getRecurrence, fingerprintFor } from "./tickets/recurrence.service.js";
import { generateDailyReport, formatDailyReportText } from "./notify/report.service.js";
import { sendDailyDigest } from "./notify/whatsapp.service.js";
import { startDailyDigestScheduler } from "./notify/scheduler.js";
import { CommandResult, SessionRequest } from "@it-sentinel/contracts";

const app = Fastify({ logger: true });

/**
 * Every collector posts here. 400 on a contract violation (never silently
 * accepted), 404 when the asset isn't registered yet (branch onboarding
 * step, not a code bug), 500 otherwise.
 */
app.post("/v1/heartbeat", async (request, reply) => {
  try {
    const result = await ingestHeartbeat(request.body);
    return reply.code(200).send(result);
  } catch (err) {
    if (err instanceof HeartbeatValidationError) {
      return reply.code(400).send({ error: "invalid_heartbeat", issues: err.issues });
    }
    if (err instanceof UnknownAssetError) {
      return reply.code(404).send({ error: "unknown_asset", message: err.message });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  }
});

/** The session broker's HTTP face. Never returns a credential — see session.service.ts. */
app.post("/v1/sessions", async (request, reply) => {
  try {
    const parsed = SessionRequest.parse(request.body);
    const grant = await requestSession(parsed);
    return reply.code(201).send(grant);
  } catch (err) {
    if (err instanceof SessionDeniedError) {
      return reply.code(403).send({ error: "session_denied", reason: err.reason });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  }
});

app.post<{ Params: { sessionId: string }; Body: { bytesTransferred: number; recordingRef?: string } }>(
  "/v1/sessions/:sessionId/end",
  async (request, reply) => {
    await endSession(request.params.sessionId, request.body.bytesTransferred, request.body.recordingRef);
    return reply.code(204).send();
  },
);

/** Voice/console/playbook dispatch — the one path into pgmq, per orchestrator.service.ts. */
app.post("/v1/commands", async (request, reply) => {
  try {
    const result = await dispatchCommand(request.body as Parameters<typeof dispatchCommand>[0]);
    return reply.code(202).send(result);
  } catch (err) {
    if (err instanceof CommandDeniedError) {
      return reply.code(403).send({ error: "command_denied", reason: err.reason });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  }
});

/** Long-poll endpoint the agent's exec loop calls to fetch queued work. */
app.get("/v1/commands/poll", async (request, reply) => {
  const messages = await pollCommands();
  return reply.code(200).send({ messages });
});

app.post<{ Params: { msgId: string } }>("/v1/commands/:msgId/result", async (request, reply) => {
  const result = CommandResult.parse(request.body);
  await reportCommandResult(Number(request.params.msgId), result);
  return reply.code(204).send();
});

/** "Seen 6 times, previous fix restart-spooler succeeded 92%." */
app.get<{ Querystring: { checkType: string; assetId: string; faultClass?: string } }>(
  "/v1/tickets/recurrence",
  async (request, reply) => {
    const fp = fingerprintFor(request.query.checkType, request.query.assetId, request.query.faultClass);
    const report = await getRecurrence(fp);
    return reply.code(200).send(report);
  },
);

app.post<{ Params: { alertId: string } }>("/v1/alerts/:alertId/open-incident", async (request, reply) => {
  const result = await openIncidentFromAlert(request.params.alertId);
  return reply.code(201).send(result);
});

/** The agentless collector's discovery source — it has no direct DB access. */
app.get("/v1/sites", async (_request, reply) => {
  const { data, error } = await db.from("sites").select("id, name, slug, primary_ip, region, criticality");
  if (error) return reply.code(500).send({ error: "internal_error" });
  return reply.code(200).send({ sites: data });
});

/** The morning report from the plan's Reports section — JSON for the console, text for WhatsApp/email. */
app.get("/v1/reports/daily", async (request, reply) => {
  const report = await generateDailyReport();
  return reply.code(200).send({ report, text: formatDailyReportText(report) });
});

app.post<{ Body: { toE164: string } }>("/v1/reports/daily/whatsapp", async (request, reply) => {
  const report = await generateDailyReport();
  const result = await sendDailyDigest(request.body.toE164, report);
  return reply.code(result.sent ? 200 : 202).send(result);
});

app.get("/healthz", async () => ({ status: "ok" }));

app
  .listen({ port: env.PORT, host: "0.0.0.0" })
  .then(() => {
    app.log.info(`control-plane listening on :${env.PORT}`);
    startDailyDigestScheduler();
  })
  .catch((err) => {
    app.log.error(err);
    process.exit(1);
  });
