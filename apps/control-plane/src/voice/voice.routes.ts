import type { FastifyInstance } from "fastify";
import {
  CONTROLLABLE_SERVICES,
  CONTROLLABLE_SERVICE_IDS,
  LAUNCHABLE_APPS,
  LAUNCHABLE_APP_IDS,
  uniqueLabels,
  type HeartbeatPayload,
} from "@it-sentinel/contracts";
import { db } from "../db.js";
import { env } from "../env.js";
import { dispatchCommand, CommandDeniedError } from "../orchestrator/orchestrator.service.js";
import { getScript, listScripts } from "../scripts/script-registry.js";

/**
 * Webhook tools for the ElevenLabs Conversational AI agent.
 *
 * These are deliberately THIN. Every one of them funnels into the same
 * dispatchCommand() the console and playbooks use, so a voice instruction
 * gets the identical policy check, the identical tier ceiling and the
 * identical audit_log entry as a typed one. Voice is an input method here,
 * not a privilege escalation path — that property is the whole reason this
 * file contains no database writes of its own beyond directives.
 *
 * Each handler returns a `speech` string. The agent reads that back
 * verbatim, which keeps phrasing (and the numbers in it) out of the LLM's
 * hands — it cannot hallucinate a machine count that this code did not
 * compute.
 */

/** Tier for voice-initiated remediation. T3 is the remediate ceiling. */
const VOICE_REMEDIATION_TIER = "T3" as const;

/**
 * Must stay <= MAX_BLAST_RADIUS_BEFORE_T5_PROMOTION in
 * orchestrator.service.ts. Kept as a separate literal on purpose: the
 * orchestrator's threshold is a policy limit that may tighten, and this is a
 * caller choosing to stay under it — importing one into the other would make
 * a future tightening silently reshape this route's batching.
 */
const BLAST_RADIUS_BATCH = 5;

/**
 * Playbooks the voice agent may trigger, mapped to the hash-pinned scripts
 * in packages/scripts/library. An allowlist, not free text: "run whatever
 * the model produced" is precisely what the executor's deny list exists to
 * prevent, and routing spoken words into a shell would hand that decision
 * to a speech-to-text engine.
 */
const VOICE_PLAYBOOKS: Record<string, { scriptId: string; label: string }> = {
  spooler: { scriptId: "restart-spooler", label: "restart the print spooler" },
  printer: { scriptId: "restart-spooler", label: "restart the print spooler" },
  "print queue": { scriptId: "clear-print-queue", label: "clear the print queue" },
  "test print": { scriptId: "test-print", label: "send a test print" },
  dns: { scriptId: "flush-dns", label: "flush DNS" },
  network: { scriptId: "ping-gateway", label: "test the gateway" },
  gateway: { scriptId: "ping-gateway", label: "test the gateway" },
  health: { scriptId: "windows-system-health", label: "run a system health check" },
  security: { scriptId: "defender-status", label: "check endpoint protection" },
  enquest: { scriptId: "enquest-check-services", label: "check Enquest services" },
};

/**
 * VOICE_PLAYBOOKS deduplicated by label, each entry keeping the key that
 * produced it.
 *
 * The key matters as much as the label: run_playbook matches on the KEY
 * appearing in the spoken action, and the key is not always a substring of
 * the label — "check endpoint protection" is only reachable by saying
 * "security". Offering a label without its keyword is how the agent comes
 * back asking for something this same server then refuses.
 *
 * Every place that tells the operator what can be run goes through here, so
 * adding a playbook above updates all of them. The alternative — a sentence
 * written out by hand — was already wrong before this function existed: the
 * run_playbook fallback listed six of the eight and silently denied that
 * "send a test print" was possible at all.
 */
function playbookOffers(): { keyword: string; label: string }[] {
  const offers: { keyword: string; label: string }[] = [];
  for (const [keyword, playbook] of Object.entries(VOICE_PLAYBOOKS)) {
    if (!offers.some((o) => o.label === playbook.label)) offers.push({ keyword, label: playbook.label });
  }
  return offers;
}

class VoiceError extends Error {
  constructor(
    public readonly status: number,
    public readonly speech: string,
  ) {
    super(speech);
  }
}

/**
 * The human these actions are attributed to. The voice agent is not a
 * user — attributing to a synthetic "voice" principal would put unowned
 * rows in audit_log, so instead we resolve the real operator who holds the
 * site grant. VOICE_OPERATOR_EMAIL pins it when more than one exists.
 */
async function resolveVoiceOperator(): Promise<string> {
  // A uuid, not an email: resolving an email would mean querying auth.users,
  // which PostgREST does not expose, and adding an RPC for it is more moving
  // parts than a pinned id is worth.
  const pinned = process.env.VOICE_OPERATOR_ID;
  if (pinned) return pinned;

  const { data, error } = await db.from("site_access").select("operator_id").limit(1).maybeSingle();
  if (error) throw error;
  if (!data?.operator_id) {
    throw new VoiceError(
      503,
      "No operator account is configured yet, so I can't act on that. Someone needs to create the operator user and re-run the bootstrap seed.",
    );
  }
  return data.operator_id as string;
}

/**
 * Spoken branch names are messy ("san paulo", "new york branch"), so this
 * reuses resolve_branch_by_voice — the existing trigram matcher over
 * sites.name + sites.voice_aliases (migration 0024) rather than a second,
 * differently-wrong matching implementation.
 *
 * Its ambiguity rule is preserved: if the top two candidates are within
 * 0.25 similarity we ask rather than guess. Acting on a coin-flip would
 * mean remediating the wrong branch.
 */
async function resolveBranch(query: string): Promise<{ id: string; name: string; slug: string }> {
  const { data, error } = await db.rpc("resolve_branch_by_voice", { p_query: query, p_limit: 3 });
  if (error) throw error;
  const matches = (data ?? []) as { id: string; name: string; slug: string; similarity: number }[];

  if (matches.length === 0) {
    throw new VoiceError(404, `I couldn't find a branch called ${query}.`);
  }
  const [top, second] = matches;
  if (second && top!.similarity - second.similarity <= 0.25) {
    throw new VoiceError(409, `Did you mean ${top!.name} or ${second.name}?`);
  }
  return { id: top!.id, name: top!.name, slug: top!.slug };
}

function pct(n: number | null | undefined): string {
  return n === null || n === undefined ? "unknown" : `${Math.round(n)} percent`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return n === 1 ? one : many;
}

/** "a, b and c" — with the one- and two-item cases handled, because "a, , or b" is audible. */
function spokenList(items: string[], conjunction = "and"): string {
  if (items.length === 0) return "";
  if (items.length === 1) return items[0]!;
  return `${items.slice(0, -1).join(", ")} ${conjunction} ${items[items.length - 1]}`;
}

/**
 * Ages are spoken, so they are rounded to a unit a person would actually
 * say. "313 seconds" is a number the listener has to convert; "five minutes"
 * is the same fact already converted.
 */
function spokenAge(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "an unknown amount of time";
  // Tested against the raw value, not the rounded one: 30 seconds rounds up
  // to "1 minute", and a freshness claim should never round in the
  // direction that makes the data sound older than it is.
  if (ms < 60_000) return "less than a minute";
  const minutes = Math.round(ms / 60_000);
  if (minutes < 60) return `${minutes} ${plural(minutes, "minute")}`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} ${plural(hours, "hour")}`;
  const days = Math.round(hours / 24);
  return `${days} ${plural(days, "day")}`;
}

function gigabytes(mb: number | undefined): string {
  return mb === undefined ? "an unknown capacity" : `${Math.round(mb / 1024)} gigabytes`;
}

/**
 * How old the newest telemetry row may be before describing it as current
 * becomes a lie. Heartbeats run on a 60-second cadence, so five minutes is
 * five missed beats — well past "the agent is a bit behind" and into "this
 * machine is not reporting". Past that line get_machine_detail leads with the
 * age instead of the numbers: an operator acting on a reading that is an hour
 * old, believing it to be live, is a worse outcome than being told there is
 * nothing fresh to report.
 */
const STALE_TELEMETRY_MS = 5 * 60 * 1000;

/** The sections of a heartbeat get_machine_detail can speak to. */
const DETAIL_TOPICS = ["printer", "network", "disk", "services", "security", "enquest"] as const;
type DetailTopic = (typeof DETAIL_TOPICS)[number];

/**
 * Telemetry rows are read back as Partial: the row was validated against
 * HeartbeatPayload at ingest, but a row written before a contract addition is
 * still perfectly good history. Re-validating here would make the voice
 * answer fail on exactly the rows the console renders fine, so every reader
 * below degrades to "not reported" instead.
 */
type TelemetrySnapshot = Partial<HeartbeatPayload>;

interface TopicReport {
  /** Drives which sections a topic of "all" bothers to speak. */
  healthy: boolean;
  speech: string;
}

const TOPIC_REPORTS: Record<DetailTopic, (p: TelemetrySnapshot) => TopicReport> = {
  printer(p) {
    const printers = p.printers ?? [];
    if (printers.length === 0) return { healthy: true, speech: "No printers are installed." };

    const faulty = printers.filter((pr) => !pr.online || pr.faultClass !== "none");
    if (faulty.length === 0) {
      return {
        healthy: true,
        speech: `All ${printers.length} ${plural(printers.length, "printer")} are online: ${spokenList(printers.map((pr) => pr.name))}.`,
      };
    }

    const described = faulty.slice(0, 3).map((pr) => {
      const bits = [pr.online ? "is online but faulting" : "is offline"];
      // Fault classes are stored snake_case for the database; hyphens and
      // underscores get spelled out by some TTS voices.
      if (pr.faultClass !== "none") bits.push(`classified as a ${pr.faultClass.replace(/_/g, " ")}`);
      if (pr.queueDepth > 0) bits.push(`${pr.queueDepth} ${plural(pr.queueDepth, "job")} queued`);
      if (pr.errorState) bits.push(`error state ${pr.errorState}`);
      return `${pr.name} ${spokenList(bits)}`;
    });
    return {
      healthy: false,
      speech: `${faulty.length} of ${printers.length} printers ${plural(faulty.length, "has", "have")} a problem: ${described.join("; ")}.`,
    };
  },

  network(p) {
    const n = p.network;
    if (!n) return { healthy: true, speech: "No network detail was reported." };

    const bits = [`the link is ${n.linkState}`];
    if (n.gatewayIp) bits.push(`the gateway is ${n.gatewayIp}`);
    if (n.latencyMs !== undefined) bits.push(`latency ${Math.round(n.latencyMs)} milliseconds`);
    if (n.packetLossPercent !== undefined) bits.push(`packet loss ${pct(n.packetLossPercent)}`);
    if (n.publicIp) bits.push(`the public address is ${n.publicIp}`);

    const healthy = n.internetReachable && n.linkState !== "disconnected" && (n.packetLossPercent ?? 0) < 5;
    return {
      healthy,
      speech: `Network: ${spokenList(bits)}. The internet is ${n.internetReachable ? "reachable" : "not reachable"}.`,
    };
  },

  disk(p) {
    const volumes = p.storage?.volumes ?? [];
    if (volumes.length === 0) return { healthy: true, speech: "No volumes were reported." };

    const describe = (v: { drive: string; freePercent: number; capacityMb: number }) =>
      `${v.drive} has ${pct(v.freePercent)} free of ${gigabytes(v.capacityMb)}`;
    // 15 percent, not the 10 the fleet summary alerts on: this is the answer
    // to "how is the disk", where "getting tight" is worth saying out loud
    // before it becomes an alert.
    const low = volumes.filter((v) => v.freePercent < 15);
    if (low.length === 0) return { healthy: true, speech: `Disk: ${spokenList(volumes.map(describe))}.` };
    return { healthy: false, speech: `Disk is tight: ${spokenList(low.map(describe))}.` };
  },

  services(p) {
    const services = p.services ?? [];
    if (services.length === 0) return { healthy: true, speech: "No service states were reported." };

    const down = services.filter((s) => s.expectedState === "running" && s.actualState !== "running");
    if (down.length === 0) {
      return { healthy: true, speech: `All ${services.length} monitored services are in their expected state.` };
    }
    return {
      healthy: false,
      speech: `${down.length} of ${services.length} monitored services ${plural(down.length, "is", "are")} not running: ${spokenList(down.map((s) => `${s.name} is ${s.actualState}`))}.`,
    };
  },

  security(p) {
    const s = p.security;
    if (!s) return { healthy: true, speech: "No endpoint protection detail was reported." };

    const bits = [
      `the service is ${s.serviceRunning ? "running" : "stopped"}`,
      `real-time protection is ${s.protectionEnabled ? "on" : "off"}`,
    ];
    if (s.definitionsAgeHours !== undefined) {
      const hours = Math.round(s.definitionsAgeHours);
      bits.push(`definitions are ${hours} ${plural(hours, "hour")} old`);
    }
    if (s.tamperProtectionEnabled === false) bits.push("tamper protection is off");
    if (s.firewallProfilesEnabled?.length === 0) bits.push("no firewall profiles are enabled");

    return {
      healthy: s.status === "healthy",
      speech: `${s.product ?? "Endpoint protection"} is ${s.status}: ${spokenList(bits)}.`,
    };
  },

  enquest(p) {
    const e = p.enquestDetail;
    if (!e) return { healthy: true, speech: "No Enquest detail was reported." };
    if (!e.installed) return { healthy: true, speech: "Enquest is not installed." };

    const bits = [
      `the process is ${e.processRunning ? "running" : "not running"}`,
      `the database is ${e.databaseReachable ? "reachable" : "unreachable"}`,
      `the sync service is ${e.syncServiceRunning ? "running" : "stopped"}`,
    ];
    bits.push(
      e.lastSuccessfulSyncAt
        ? `it last synced ${spokenAge(Date.now() - Date.parse(e.lastSuccessfulSyncAt))} ago`
        : "it has never synced successfully",
    );
    if (e.recentErrorCount > 0) {
      bits.push(
        `there ${e.recentErrorCount === 1 ? "is" : "are"} ${e.recentErrorCount} recent ${plural(e.recentErrorCount, "error")}` +
          (e.mostCommonError ? `, most commonly ${e.mostCommonError}` : ""),
      );
    }
    return { healthy: e.status === "healthy", speech: `Enquest is ${e.status}: ${spokenList(bits)}.` };
  },
};

export function registerVoiceRoutes(app: FastifyInstance) {
  /**
   * These routes are publicly reachable so ElevenLabs can call them, so
   * they carry a shared secret. If VOICE_WEBHOOK_SECRET is unset the routes
   * refuse outright rather than defaulting to open — an unauthenticated
   * public endpoint that can restart services on a fleet is not an
   * acceptable failure mode, even for a demo.
   */
  app.addHook("preHandler", async (request, reply) => {
    if (!request.url.startsWith("/v1/voice/")) return;
    // /speak is called by the logged-in console, not by ElevenLabs, so it
    // does not carry the webhook secret. It performs no fleet action — it
    // only turns text into audio — so it is not gated here.
    if (request.url.startsWith("/v1/voice/speak")) return;
    // These carry `ok` and `status` in the body like every handle() response,
    // so a caller branching on `ok` gets false here rather than undefined.
    // The HTTP code stays non-2xx though: unlike a disambiguation or a policy
    // refusal, a rejected key is not an answer the agent should read out and
    // reason about — it is a call that never reached the fleet at all.
    if (!env.VOICE_WEBHOOK_SECRET) {
      return reply
        .code(503)
        .send({ ok: false, status: 503, speech: "Voice control is not configured on the server." });
    }
    if (request.headers["x-sentinel-voice-key"] !== env.VOICE_WEBHOOK_SECRET) {
      return reply.code(401).send({ ok: false, status: 401, speech: "I'm not authorised to do that." });
    }
  });

  /**
   * Conversational outcomes return HTTP 200, not 4xx.
   *
   * "Did you mean Nyali A or Nyali B?" and "that was refused by policy" are
   * ANSWERS the agent must speak, not transport failures. Agent frameworks
   * commonly treat a non-2xx tool response as a failed call and drop the
   * body before the model ever sees it — which would silently remove the two
   * behaviours this whole design leans on: asking instead of guessing, and
   * reporting refusals honestly. The agent would fall back to improvising,
   * which is precisely what returning a server-computed `speech` exists to
   * prevent.
   *
   * The real status is preserved in the body as `status` for logs and for
   * the console, and `ok: false` lets any caller that wants to branch do so.
   * Genuine transport failures — a bad shared secret (401, raised by the
   * preHandler above) and unexpected exceptions (500) — stay non-2xx,
   * because those the agent genuinely cannot act on.
   */
  const handle = (fn: (body: any) => Promise<{ speech: string; [k: string]: unknown }>) =>
    async (request: any, reply: any) => {
      try {
        return reply.code(200).send({ ok: true, ...(await fn(request.body ?? {})) });
      } catch (err) {
        if (err instanceof VoiceError) {
          return reply.code(200).send({ ok: false, status: err.status, speech: err.speech });
        }
        if (err instanceof CommandDeniedError) {
          return reply.code(200).send({
            ok: false,
            status: 403,
            speech: `That was refused by policy: ${err.reason}.`,
            refusalReason: err.reason,
          });
        }
        request.log.error(err);
        return reply.code(500).send({ ok: false, status: 500, speech: "Something went wrong reaching the fleet." });
      }
    };

  /** "How is the fleet?" */
  app.post(
    "/v1/voice/fleet",
    handle(async () => {
      const { data, error } = await db
        .from("asset_health")
        .select("status, online, assets!inner(hostname, sites!inner(name))");
      if (error) throw error;

      const rows = (data ?? []) as any[];
      if (rows.length === 0) {
        return { speech: "No machines are reporting yet. The agents may not be running.", total: 0 };
      }

      const critical = rows.filter((r) => r.status === "critical");
      const warning = rows.filter((r) => r.status === "warning");
      const offline = rows.filter((r) => !r.online);

      const parts = [`${rows.length} machines are registered.`];
      if (critical.length === 0 && warning.length === 0 && offline.length === 0) {
        parts.push("Everything is healthy.");
      } else {
        if (critical.length) {
          const names = critical.slice(0, 3).map((r) => r.assets.sites.name).join(", ");
          parts.push(`${critical.length} critical: ${names}.`);
        }
        if (warning.length) parts.push(`${warning.length} showing warnings.`);
        if (offline.length) parts.push(`${offline.length} offline.`);
      }

      return {
        speech: parts.join(" "),
        total: rows.length,
        critical: critical.length,
        warning: warning.length,
        offline: offline.length,
      };
    }),
  );

  /** "What's wrong in Lagos?" */
  app.post(
    "/v1/voice/branch",
    handle(async (body) => {
      const branch = await resolveBranch(String(body.branch ?? body.query ?? ""));
      const { data, error } = await db
        .from("asset_health")
        .select("status, online, ram_usage, disk_free_percent, printer_status, enquest_status, endpoint_security_status, assets!inner(hostname, site_id)")
        .eq("assets.site_id", branch.id);
      if (error) throw error;

      const rows = (data ?? []) as any[];
      if (rows.length === 0) {
        return { speech: `${branch.name} has no machines reporting yet.`, branch: branch.name };
      }

      const bad = rows.filter((r) => r.status !== "healthy" || !r.online);
      if (bad.length === 0) {
        return { speech: `${branch.name} is fully healthy across ${rows.length} machines.`, branch: branch.name };
      }

      const faults: string[] = [];
      for (const r of bad) {
        const issues: string[] = [];
        if (!r.online) issues.push("offline");
        if (r.printer_status === "critical") issues.push("printer fault");
        if (r.enquest_status === "critical") issues.push("Enquest down");
        if (r.endpoint_security_status !== "healthy") issues.push("endpoint protection issue");
        if (r.disk_free_percent !== null && r.disk_free_percent < 10) issues.push(`disk at ${pct(r.disk_free_percent)} free`);
        if (r.ram_usage !== null && r.ram_usage > 90) issues.push(`memory at ${pct(r.ram_usage)}`);
        faults.push(`${r.assets.hostname}: ${issues.length ? issues.join(", ") : r.status}`);
      }

      return {
        speech: `${branch.name} has ${bad.length} of ${rows.length} machines with problems. ${faults.slice(0, 3).join(". ")}.`,
        branch: branch.name,
        faults,
      };
    }),
  );

  /**
   * "Why is the printer down in Lagos?" — the numbers behind the summary.
   *
   * get_branch_status answers from asset_health, which is a handful of
   * roll-up columns. The heartbeat that produced them carries printer names,
   * gateway latency, per-volume free space and Enquest error counts, and
   * ingest.service.ts writes all of it into telemetry.payload on every beat —
   * where, until this route, nothing ever read it. So the agent could say
   * "the printer is critical" and had nothing to follow up with.
   */
  app.post(
    "/v1/voice/detail",
    handle(async (body) => {
      const branch = await resolveBranch(String(body.branch ?? body.query ?? ""));
      const requested = String(body.topic ?? "all").trim().toLowerCase();
      const topic: DetailTopic | "all" | undefined =
        requested === "" || requested === "all" ? "all" : DETAIL_TOPICS.find((t) => requested.includes(t));

      if (!topic) {
        return {
          speech: `I can go into detail on printers, network, disk, services, security or Enquest. I don't have a "${requested}" section.`,
        };
      }

      const { data: assets, error } = await db.from("assets").select("id, hostname").eq("site_id", branch.id);
      if (error) throw error;
      if (!assets?.length) throw new VoiceError(404, `${branch.name} has no machines registered.`);

      // Newest row across the branch's assets, not per-asset: the question
      // being answered is "what is going on at this branch right now", and
      // fanning out one query per machine to then narrate five of them is not
      // an answer anyone can listen to.
      const { data: telemetry, error: tErr } = await db
        .from("telemetry")
        .select("asset_id, recorded_at, payload")
        .in("asset_id", assets.map((a) => a.id))
        .order("recorded_at", { ascending: false })
        .limit(1);
      if (tErr) throw tErr;

      const row = (telemetry ?? [])[0] as
        | { asset_id: string; recorded_at: string; payload: TelemetrySnapshot | null }
        | undefined;
      if (!row?.payload) {
        throw new VoiceError(
          404,
          `${branch.name} hasn't sent any telemetry yet, so I have no detail to give you. Its agent may not be running.`,
        );
      }

      const payload = row.payload;
      const recordedAt = row.recorded_at ?? payload.collectedAt ?? null;
      const ageMs = recordedAt ? Date.now() - Date.parse(recordedAt) : Number.NaN;
      const stale = !Number.isFinite(ageMs) || ageMs > STALE_TELEMETRY_MS;
      const hostname =
        payload.hostname ?? assets.find((a) => a.id === row.asset_id)?.hostname ?? branch.name;

      const topics: DetailTopic[] = topic === "all" ? [...DETAIL_TOPICS] : [topic];
      const reports = topics.map((t) => ({ topic: t, ...TOPIC_REPORTS[t](payload) }));

      let detail: string;
      if (topic === "all") {
        // Reading all six sections aloud is a monologue nobody listens to the
        // end of, so "all" means "everything that is wrong", and explicitly
        // says so when nothing is.
        const problems = reports.filter((r) => !r.healthy);
        detail = problems.length
          ? `${problems.length} ${plural(problems.length, "area needs", "areas need")} attention. ${problems.map((r) => r.speech).join(" ")}`
          : `Nothing stands out. ${reports.find((r) => r.topic === "disk")!.speech} ${reports.find((r) => r.topic === "network")!.speech}`;
      } else {
        detail = reports[0]!.speech;
      }

      // The age leads the sentence when the data is stale, and it leads it
      // with a warning rather than a footnote. An operator who hears
      // "latency is 12 milliseconds" and acts on it has no way to know the
      // reading came from an hour ago unless this says so first.
      const lead = stale
        ? `Careful: the newest telemetry from ${hostname} at ${branch.name} is ${spokenAge(ageMs)} old, so this is not live. As of then,`
        : `${hostname} at ${branch.name}, reported ${spokenAge(ageMs)} ago:`;

      return {
        speech: `${lead} ${detail}`,
        branch: branch.name,
        hostname,
        topic,
        recordedAt,
        stale,
        ageSeconds: Number.isFinite(ageMs) ? Math.round(ageMs / 1000) : null,
        reports,
      };
    }),
  );

  /** "Restart the print spooler on Lagos." */
  app.post(
    "/v1/voice/remediate",
    handle(async (body) => {
      const branch = await resolveBranch(String(body.branch ?? ""));
      const requested = String(body.action ?? "").toLowerCase();

      const key = Object.keys(VOICE_PLAYBOOKS).find((k) => requested.includes(k));
      if (!key) {
        return {
          speech: `I can ${spokenList(playbookOffers().map((p) => p.label), "or")}. I can't do "${requested}" by voice.`,
        };
      }
      const playbook = VOICE_PLAYBOOKS[key]!;

      const { data: assets, error } = await db.from("assets").select("id, hostname").eq("site_id", branch.id);
      if (error) throw error;
      if (!assets?.length) throw new VoiceError(404, `${branch.name} has no machines registered.`);

      // The executor refuses a signed_script with no dispatch-side hash, so
      // resolve it here rather than letting the command fail on the agent.
      const script = getScript(playbook.scriptId);
      if (!script) {
        throw new VoiceError(503, `The ${playbook.label} playbook isn't available on the server right now.`);
      }

      const operatorId = await resolveVoiceOperator();
      const { commandIds } = await dispatchCommand({
        assetIds: assets.map((a) => a.id),
        operatorId,
        kind: "signed_script",
        scriptId: script.scriptId,
        scriptVersion: script.version,
        scriptSha256: script.sha256,
        tier: VOICE_REMEDIATION_TIER,
      });

      // "Dispatched", not "done", and no promise to report back: this
      // returns as soon as the command is queued, and nothing here pushes a
      // result anywhere. The agent has to call check_status to learn the
      // outcome. Saying "I'll report back" would be a promise the system
      // cannot keep, and on stage it reads as the fix having worked.
      return {
        speech: `Dispatched: ${playbook.label} on ${assets.length} machine${assets.length === 1 ? "" : "s"} at ${branch.name}. Ask me to check the status in a few seconds.`,
        branch: branch.name,
        dispatched: assets.length,
        commandIds,
      };
    }),
  );

  /** "What can you run?" — so the agent never invents a playbook name. */
  app.post(
    "/v1/voice/playbooks",
    handle(async () => {
      const scripts = listScripts();
      if (scripts.length === 0) {
        throw new VoiceError(503, "The playbook library isn't loaded on the server.");
      }
      // Spoken aliases, not script ids: "restart-spooler" is not a phrase
      // anyone says out loud, and the agent should hear back the same
      // vocabulary that run_playbook actually matches on.
      const labels = [...new Set(Object.values(VOICE_PLAYBOOKS).map((p) => p.label))];
      return {
        speech: `I can ${labels.slice(0, -1).join(", ")}, or ${labels[labels.length - 1]}.`,
        playbooks: labels,
        scriptIds: scripts.map((s) => s.scriptId),
      };
    }),
  );

  /**
   * "What can you do?" — the agent's own inventory, computed not written.
   *
   * Every list in this response is derived from the registry that actually
   * backs the corresponding tool: VOICE_PLAYBOOKS for remediation, the shared
   * vocabulary in @it-sentinel/contracts for apps and services, DETAIL_TOPICS
   * for machine detail. A hand-written list here would be correct on the day
   * it was written and wrong on the day someone adds an entry — and the way
   * that goes wrong is the agent cheerfully offering a capability that
   * refuses when the operator takes it up on the offer.
   */
  app.post(
    "/v1/voice/capabilities",
    handle(async () => {
      const playbooks = playbookOffers();
      const playbookLabels = playbooks.map((p) => p.label);
      const appLabels = uniqueLabels(LAUNCHABLE_APPS);
      const serviceLabels = uniqueLabels(CONTROLLABLE_SERVICES);
      const scripts = listScripts();

      // Grouped and headline-only. The full lists go back in the structured
      // fields for the agent to draw on when asked to narrow down; reading
      // thirteen app names aloud is not an answer to "what can you do".
      const sections = [
        "Here's what I can do.",
        "For monitoring, I can summarise the whole fleet, report faults for one branch, give you the detail behind them — printers, network, disk, services, endpoint security or Enquest — and tell you how recent commands turned out.",
        scripts.length === 0
          ? "Remediation playbooks aren't loaded on the server at the moment, so I can't run one right now."
          : `For remediation, I can ${spokenList(playbookLabels, "or")}.`,
        `I can start, stop or restart ${serviceLabels.length} services, including ${spokenList(serviceLabels.slice(0, 3))}.`,
        `I can open ${appLabels.length} applications, including ${spokenList(appLabels.slice(0, 3))}.`,
        "And for remote control, I can put a branch's machine on your screen, or open the camera on every machine at once.",
      ];

      return {
        speech: sections.join(" "),
        playbooks,
        scriptIds: scripts.map((s) => s.scriptId),
        apps: LAUNCHABLE_APP_IDS.map((id) => ({ id, label: LAUNCHABLE_APPS[id] })),
        services: CONTROLLABLE_SERVICE_IDS.map((id) => ({ id, label: CONTROLLABLE_SERVICES[id] })),
        detailTopics: [...DETAIL_TOPICS],
      };
    }),
  );

  /**
   * "Restart the spooler service on Lagos."
   *
   * Distinct from run_playbook: a playbook is a reviewed, hash-pinned script,
   * whereas this is a direct service state change. The service NAME is
   * resolved against an allowlist on the agent, never interpolated from
   * speech — see apps/agent-node/src/exec/service-actions.ts. T6 still
   * applies, so "stop Defender" is refused no matter who asks.
   */
  app.post(
    "/v1/voice/service",
    handle(async (body) => {
      const branch = await resolveBranch(String(body.branch ?? ""));
      const service = String(body.service ?? "").trim();
      const action = String(body.action ?? "").toLowerCase();

      if (!service) return { speech: "Which service should I act on?" };
      if (action !== "start" && action !== "stop" && action !== "restart") {
        return { speech: `I can start, stop or restart a service. I don't know how to "${action}" one.` };
      }

      const { data: assets, error } = await db.from("assets").select("id, hostname").eq("site_id", branch.id);
      if (error) throw error;
      if (!assets?.length) throw new VoiceError(404, `${branch.name} has no machines registered.`);

      const operatorId = await resolveVoiceOperator();
      const { commandIds } = await dispatchCommand({
        assetIds: assets.map((a) => a.id),
        operatorId,
        kind: "service_action",
        serviceName: service,
        serviceAction: action,
        // T3: a service state change is remediation, and T3 is the tier whose
        // allowlist already contains Start/Stop/Restart-Service.
        tier: VOICE_REMEDIATION_TIER,
      });

      return {
        speech: `Sent a ${action} of the ${service} service to ${assets.length} machine${assets.length === 1 ? "" : "s"} at ${branch.name}. Ask me to check the status in a few seconds.`,
        branch: branch.name,
        dispatched: assets.length,
        commandIds,
      };
    }),
  );

  /**
   * "Did that work?" — the other half of every dispatch.
   *
   * Everything above is fire-and-forget onto a queue, so without this the
   * agent can only ever say it sent something. This reads the actual
   * transcript rows the agent wrote back, which is the difference between
   * claiming a fix and confirming one.
   */
  app.post(
    "/v1/voice/status",
    handle(async (body) => {
      const scope = String(body.branch ?? "").trim();
      let siteId: string | null = null;
      let label = "the fleet";
      if (scope && scope.toLowerCase() !== "all") {
        const branch = await resolveBranch(scope);
        siteId = branch.id;
        label = branch.name;
      }

      // A 15-minute window: older rows are history, not "did that just
      // work?", and including them would have the agent report a stale
      // success after a fresh failure.
      const since = new Date(Date.now() - 15 * 60 * 1000).toISOString();

      let q = db
        .from("command_runs")
        .select("kind, script_id, outcome, exit_code, refusal_reason, finished_at, assets!inner(hostname, site_id)")
        .gte("created_at", since)
        .order("created_at", { ascending: false })
        .limit(20);
      if (siteId) q = q.eq("assets.site_id", siteId);

      const { data, error } = await q;
      if (error) throw error;
      const rows = (data ?? []) as any[];

      if (rows.length === 0) {
        return { speech: `Nothing has been run on ${label} in the last fifteen minutes.`, total: 0 };
      }

      const pending = rows.filter((r) => r.outcome === null || r.outcome === undefined);
      const succeeded = rows.filter((r) => r.outcome === "success");
      const refused = rows.filter((r) => r.outcome === "refused");
      const failed = rows.filter((r) => r.outcome === "failure" || r.outcome === "timeout");

      const parts: string[] = [];
      if (succeeded.length) parts.push(`${succeeded.length} succeeded`);
      if (failed.length) parts.push(`${failed.length} failed`);
      if (refused.length) parts.push(`${refused.length} refused by policy`);
      if (pending.length) parts.push(`${pending.length} still running`);

      // Name the first thing that went wrong. A bare count tells the
      // operator something is broken without telling them what to look at.
      const firstBad = failed[0] ?? refused[0];
      const detail = firstBad
        ? ` The ${firstBad.script_id ?? firstBad.kind} on ${firstBad.assets.hostname} ${
            firstBad.outcome === "refused" ? `was refused: ${firstBad.refusal_reason ?? "policy"}` : `failed with exit code ${firstBad.exit_code}`
          }.`
        : "";

      return {
        speech: `On ${label}, of the last ${rows.length} commands: ${parts.join(", ")}.${detail}`,
        total: rows.length,
        succeeded: succeeded.length,
        failed: failed.length,
        refused: refused.length,
        pending: pending.length,
      };
    }),
  );

  /** "Open Lagos." — drives the operator's screen via a console directive. */
  app.post(
    "/v1/voice/open",
    handle(async (body) => {
      const branch = await resolveBranch(String(body.branch ?? ""));
      const { data: assets, error } = await db
        .from("assets")
        .select("id, hostname, ip")
        .eq("site_id", branch.id)
        .order("hostname");
      if (error) throw error;
      if (!assets?.length) throw new VoiceError(404, `${branch.name} has no machines registered.`);

      const target = assets[0]!;
      if (!target.ip || target.ip === "0.0.0.0") {
        throw new VoiceError(
          409,
          `${branch.name} hasn't reported a network address yet, so I can't open a session. Its agent may have only just started.`,
        );
      }

      const operatorId = await resolveVoiceOperator();
      const { error: dErr } = await db.from("console_directives").insert({
        operator_id: operatorId,
        kind: "open_machine",
        site_id: branch.id,
        asset_id: target.id,
        payload: { hostname: target.hostname, mode: body.mode === "view" ? "view" : "control" },
      });
      if (dErr) throw dErr;

      return {
        speech: `Opening ${target.hostname} at ${branch.name} on your screen now.`,
        branch: branch.name,
        hostname: target.hostname,
      };
    }),
  );

  /**
   * Text-to-speech proxy for the console's proactive fault announcements.
   *
   * The browser posts text and gets audio back; the ElevenLabs API key stays
   * on the server. Calling ElevenLabs directly from the console would mean
   * shipping that key to every operator's browser, where it is readable by
   * anyone who opens devtools.
   *
   * Exempt from the shared-secret hook below (it is called by the logged-in
   * console, not by ElevenLabs) but rate-limited by its own short text cap.
   */
  app.post<{ Body: { text?: string } }>("/v1/voice/speak", async (request, reply) => {
    const apiKey = process.env.ELEVENLABS_API_KEY;
    if (!apiKey) return reply.code(503).send({ error: "tts_unconfigured" });

    const text = String(request.body?.text ?? "").slice(0, 600);
    if (!text.trim()) return reply.code(400).send({ error: "empty_text" });

    const voiceId = process.env.ELEVENLABS_VOICE_ID ?? "21m00Tcm4TlvDq8ikWAM";
    const res = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${voiceId}`, {
      method: "POST",
      headers: { "xi-api-key": apiKey, "content-type": "application/json" },
      body: JSON.stringify({
        text,
        model_id: process.env.ELEVENLABS_MODEL_ID ?? "eleven_turbo_v2_5",
        voice_settings: { stability: 0.4, similarity_boost: 0.75 },
      }),
    }).catch(() => null);

    if (!res || !res.ok) {
      request.log.error({ status: res?.status }, "elevenlabs tts failed");
      return reply.code(502).send({ error: "tts_failed", status: res?.status ?? 0 });
    }

    return reply.code(200).type("audio/mpeg").send(Buffer.from(await res.arrayBuffer()));
  });

  /** "Open Chrome on Lagos." */
  app.post(
    "/v1/voice/launch",
    handle(async (body) => {
      const branch = await resolveBranch(String(body.branch ?? ""));
      const appId = String(body.app ?? body.appId ?? "").trim();
      if (!appId) return { speech: "Which application should I open?" };

      const { data: assets, error } = await db.from("assets").select("id, hostname").eq("site_id", branch.id);
      if (error) throw error;
      if (!assets?.length) throw new VoiceError(404, `${branch.name} has no machines registered.`);

      const operatorId = await resolveVoiceOperator();
      // T2: launching an allowlisted app changes no system state and is
      // reversible by closing the window.
      const { commandIds } = await dispatchCommand({
        assetIds: [assets[0]!.id],
        operatorId,
        kind: "app_launch",
        appId,
        tier: "T2",
      });

      return {
        speech: `Opening ${appId} on ${assets[0]!.hostname} at ${branch.name}.`,
        branch: branch.name,
        commandIds,
      };
    }),
  );

  /**
   * "Open all cameras." — fan-out app launch across every branch, or one.
   *
   * This opens the Windows Camera app on each machine and nothing more. It
   * deliberately does not capture, upload or analyse frames: a launch is
   * reversible by closing the window and moves no image data off the
   * endpoint, which is a very different thing to ask a fleet to do.
   */
  app.post(
    "/v1/voice/cameras",
    handle(async (body) => {
      const scope = String(body.branch ?? "all").toLowerCase();
      const allBranches = scope === "all" || scope === "everywhere" || scope === "";

      let siteId: string | null = null;
      let label = "all branches";
      if (!allBranches) {
        const branch = await resolveBranch(scope);
        siteId = branch.id;
        label = branch.name;
      }

      let q = db.from("assets").select("id, hostname, site_id");
      if (siteId) q = q.eq("site_id", siteId);
      const { data: assets, error } = await q;
      if (error) throw error;
      if (!assets?.length) throw new VoiceError(404, `No machines are registered for ${label}.`);

      const operatorId = await resolveVoiceOperator();
      const { error: dErr } = await db.from("console_directives").insert({
        operator_id: operatorId,
        kind: "open_cameras",
        site_id: siteId,
        payload: { scope: label, assetCount: assets.length },
      });
      if (dErr) throw dErr;

      // Dispatched in batches of BLAST_RADIUS_BATCH rather than as one
      // fan-out, because dispatchCommand auto-promotes anything touching
      // more than five assets to T5.
      //
      // Note what that promotion does and does not do today: evaluateCommandPolicy
      // returns requiresDualApproval for T5, but dispatchCommand only checks
      // `allowed`, so nothing actually enforces the second approver. An
      // it_manager (ceiling T5) would therefore sail straight through a
      // seven-asset dispatch — it would not be refused. Batching is not
      // working around a denial that would happen; it is declining to lean
      // on a promotion whose safeguard is currently advisory.
      //
      // It also keeps the feature working for the roles that would genuinely
      // be blocked — l1_support caps at T2, l2/l3 below T5 — and each batch
      // is independently policy-checked and writes its own audit_log rows.
      const batches: string[][] = [];
      for (let i = 0; i < assets.length; i += BLAST_RADIUS_BATCH) {
        batches.push(assets.slice(i, i + BLAST_RADIUS_BATCH).map((a) => a.id));
      }

      const commandIds: string[] = [];
      let opened = 0;
      for (const batch of batches) {
        try {
          const res = await dispatchCommand({
            operatorId,
            assetIds: batch,
            kind: "app_launch",
            appId: "camera",
            // T2: opening an allowlisted app changes no system state and
            // the person at the machine closes the window to undo it.
            tier: "T2",
          });
          commandIds.push(...res.commandIds);
          opened += batch.length;
        } catch (err) {
          // A partial fan-out is the honest answer here. Rethrowing would
          // have the agent say the whole thing was refused when machines
          // already have a camera window open on screen.
          if (err instanceof CommandDeniedError && opened > 0) {
            return {
              speech: `I opened the camera on ${opened} of ${assets.length} machines across ${label}. The rest were refused by policy: ${err.reason}.`,
              assetCount: assets.length,
              opened,
              commandIds,
            };
          }
          throw err;
        }
      }

      return {
        speech: `Opening the camera on ${opened} machine${opened === 1 ? "" : "s"} across ${label}.`,
        assetCount: assets.length,
        opened,
        commandIds,
      };
    }),
  );
}
