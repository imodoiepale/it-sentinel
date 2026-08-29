import Fastify from "fastify";
import cors from "@fastify/cors";
import { db } from "./db.js";
import { env } from "./env.js";
import { HeartbeatValidationError, UnknownAssetError, AssetRetiredError, ingestHeartbeat } from "./ingest/ingest.service.js";
import { requestSession, SessionDeniedError, endSession } from "./session/session.service.js";
import { dispatchCommand, pollCommands, reportCommandResult, CommandDeniedError } from "./orchestrator/orchestrator.service.js";
import { openIncidentFromAlert, getRecurrence, fingerprintFor } from "./tickets/recurrence.service.js";
import { generateDailyReport, formatDailyReportText } from "./notify/report.service.js";
import { sendDailyDigest } from "./notify/whatsapp.service.js";
import { startDailyDigestScheduler } from "./notify/scheduler.js";
import { registerVoiceRoutes } from "./voice/voice.routes.js";
import { registerAuthRoutes } from "./auth/reauth.routes.js";
import { runWithElevationToken } from "./auth/elevation.context.js";
import { elevationReference } from "./auth/elevation.store.js";
import { CommandResult, SessionRequest } from "@it-sentinel/contracts";

const app = Fastify({ logger: true });

/**
 * The console runs on a different origin to this API (localhost:3210 in dev,
 * two separate Render services in production), and it calls /v1/sessions and
 * /v1/commands directly from the browser — so without CORS every remote
 * desktop request and every terminal command is blocked before it leaves the
 * page.
 *
 * CORS_ORIGINS is a comma-separated allowlist. It falls back to reflecting
 * the request origin ONLY when unset, which keeps local development working;
 * set it in production. Note this is not an authentication boundary — the
 * routes' own policy checks are — but an open default in a deployed
 * environment is still worth avoiding.
 */
await app.register(cors, {
  origin: process.env.CORS_ORIGINS ? process.env.CORS_ORIGINS.split(",").map((o) => o.trim()) : true,
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["content-type", "authorization", "x-sentinel-voice-key"],
  credentials: true,
});

// Webhook tools for the ElevenLabs conversational agent. Registered here so
// they share this instance's policy path and audit trail — see voice.routes.ts.
registerVoiceRoutes(app);

// Operator password re-authentication, the gate in front of T4 — see
// auth/reauth.routes.ts. Nothing else in this process can mint an elevation.
registerAuthRoutes(app);

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
    if (err instanceof AssetRetiredError) {
      return reply.code(410).send({ error: "asset_retired", message: err.message });
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

/**
 * Voice/console/playbook dispatch — the one path into pgmq, per
 * orchestrator.service.ts.
 *
 * `elevationToken` is optional and only meaningful at T4. Existing T1-T3
 * callers, including every voice route, send a body without it and are
 * unaffected; a T4 body without one is denied by evaluateCommandPolicy.
 *
 * Two things happen to the token here and nowhere else:
 *  - it is put into request-scoped context for the policy check, and
 *  - it is REPLACED by a one-way reference before dispatch, so what travels
 *    to the queue, command_runs and the agent is a handle to the elevation
 *    rather than the secret that unlocked it. The agent refuses ad-hoc T4
 *    without that reference, which makes a hand-built T4 envelope that never
 *    passed through here refusable at the machine as well as at the API.
 */
app.post("/v1/commands", async (request, reply) => {
  try {
    const { elevationToken, ...body } = (request.body ?? {}) as Parameters<typeof dispatchCommand>[0] & {
      elevationToken?: string;
    };
    const args: Parameters<typeof dispatchCommand>[0] = elevationToken
      ? { ...body, cmdArgs: { ...(body.cmdArgs ?? {}), elevationRef: elevationReference(elevationToken) } }
      : body;

    const result = await runWithElevationToken(elevationToken, () => dispatchCommand(args));
    return reply.code(202).send(result);
  } catch (err) {
    if (err instanceof CommandDeniedError) {
      return reply.code(403).send({ error: "command_denied", reason: err.reason });
    }
    request.log.error(err);
    return reply.code(500).send({ error: "internal_error" });
  }
});

/**
 * Long-poll endpoint the agent's exec loop calls to fetch queued work.
 * assetId is required — see pollCommands(). Refusing the unfiltered call
 * with a 400 is deliberate: an agent that somehow omits it must fail loudly
 * rather than quietly drain the whole fleet's queue.
 */
app.get<{ Querystring: { assetId?: string } }>("/v1/commands/poll", async (request, reply) => {
  const assetId = request.query.assetId;
  if (!assetId) {
    return reply.code(400).send({ error: "missing_asset_id", message: "assetId query parameter is required" });
  }
  const messages = await pollCommands(assetId);
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

/**
 * A landing page for the API root.
 *
 * There is nothing to serve at `/` — this process is an API and the console
 * is a separate service — but Fastify's bare 404 ("Route GET:/ not found")
 * reads as a broken deployment to anyone who pastes the URL into a browser,
 * which is the first thing everybody does. Saying what this is, and where
 * the console lives, costs one route.
 */
app.get("/", async () => ({
  service: "it-sentinel-control-plane",
  status: "ok",
  note: "This is the API, not the dashboard. There is no page here by design.",
  console: process.env.CONSOLE_URL ?? "https://it-sentinel-web.onrender.com",
  health: "/healthz",
  endpoints: {
    fleet: "GET /v1/sites",
    heartbeat: "POST /v1/heartbeat",
    voice: "POST /v1/voice/* (requires the x-sentinel-voice-key header)",
  },
}));

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
