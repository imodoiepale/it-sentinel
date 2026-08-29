import { beforeEach, describe, expect, it, vi } from "vitest";
import Fastify from "fastify";

/**
 * The voice webhooks are the ElevenLabs agent's entire surface, so the
 * properties tested here are the ones that decide whether the agent behaves
 * or misleads: the shared-secret gate, that a dispatch reports "sent" rather
 * than "done", and that every response carries the `speech` field the agent
 * reads aloud. A handler that 500s or omits `speech` leaves the agent
 * improvising, which is exactly the failure mode we cannot have on stage.
 *
 * Routed through Fastify's inject() rather than by calling the handlers
 * directly, because the preHandler auth hook is part of what's under test.
 */

const state = vi.hoisted(() => ({
  branchMatches: [{ site_id: "site-1", name: "Lagos", slug: "lagos", similarity: 0.9 }] as any[],
  assets: [{ id: "asset-1", hostname: "LAGOS-POS-01", ip: "192.168.1.11", site_id: "site-1" }] as any[],
  operatorRow: { operator_id: "operator-1" } as any,
  commandRuns: [] as any[],
  telemetry: [] as any[],
  assetHealth: [] as any[],
  alerts: [] as any[],
  incidents: [] as any[],
  dispatched: [] as any[],
  dispatchThrows: null as Error | null,
  retireCalls: [] as any[],
  retireResult: { already_retired: false } as any,
  retireError: null as any,
  /**
   * Per-query branch matches. /v1/voice/reassign resolves TWO branch names in
   * one turn, so a single shared answer would make every move a move to the
   * branch it started at — the one case the route short-circuits.
   */
  branchMatchesByQuery: {} as Record<string, any[]>,
  reassignCalls: [] as any[],
  reassignResult: { already_there: false, to_site_name: "Dubai", alerts_moved: 0 } as any,
  reassignError: null as any,
}));

vi.mock("../src/db.js", () => {
  function table(name: string) {
    const rows = () => {
      if (name === "assets") return state.assets;
      if (name === "site_access") return [state.operatorRow];
      if (name === "command_runs") return state.commandRuns;
      if (name === "telemetry") return state.telemetry;
      if (name === "asset_health") return state.assetHealth;
      if (name === "alerts") return state.alerts;
      if (name === "incidents") return state.incidents;
      return [];
    };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
      is: () => chain,
      like: () => chain,
      gte: () => chain,
      order: () => chain,
      limit: () => chain,
      insert: async () => ({ error: null }),
      maybeSingle: async () => ({ data: rows()[0] ?? null, error: null }),
      then: (resolve: any) => resolve({ data: rows(), error: null }),
    };
    return chain;
  }
  return {
    db: {
      from: (name: string) => table(name),
      rpc: async (fn: string, params?: any) => {
        if (fn === "resolve_branch_by_voice") {
          return { data: state.branchMatchesByQuery[params?.p_query] ?? state.branchMatches, error: null };
        }
        if (fn === "retire_asset") {
          state.retireCalls.push(params);
          if (state.retireError) return { data: null, error: state.retireError };
          return { data: [state.retireResult], error: null };
        }
        if (fn === "reassign_asset") {
          state.reassignCalls.push(params);
          if (state.reassignError) return { data: null, error: state.reassignError };
          return { data: [state.reassignResult], error: null };
        }
        return { data: null, error: null };
      },
    },
  };
});

vi.mock("../src/orchestrator/orchestrator.service.js", async () => {
  const actual = await vi.importActual<any>("../src/orchestrator/orchestrator.service.js");
  return {
    ...actual,
    dispatchCommand: vi.fn(async (args: any) => {
      if (state.dispatchThrows) throw state.dispatchThrows;
      state.dispatched.push(args);
      return { commandIds: args.assetIds.map((_: string, i: number) => `cmd-${i}`) };
    }),
  };
});

vi.mock("../src/scripts/script-registry.js", () => ({
  getScript: (id: string) => ({ scriptId: id, name: id, category: "test", tier: "T3", version: "1.0.0", sha256: "a".repeat(64), timeoutSeconds: 30 }),
  listScripts: () => [{ scriptId: "restart-spooler", name: "Restart Print Spooler", category: "printer", tier: "T3", version: "1.0.0", sha256: "a".repeat(64), timeoutSeconds: 30 }],
}));

const SECRET = "test-voice-secret";
process.env.VOICE_WEBHOOK_SECRET = SECRET;
vi.mock("../src/env.js", () => ({ env: { PORT: 8787, RELAY_PUBLIC_URL: "ws://127.0.0.1:8788", VOICE_WEBHOOK_SECRET: "test-voice-secret" } }));

const { registerVoiceRoutes } = await import("../src/voice/voice.routes.js");

function buildApp() {
  const app = Fastify();
  registerVoiceRoutes(app);
  return app;
}

async function call(path: string, body: unknown, secret: string | null = SECRET) {
  const app = buildApp();
  const res = await app.inject({
    method: "POST",
    url: path,
    payload: body ?? {},
    headers: secret === null ? {} : { "x-sentinel-voice-key": secret },
  });
  await app.close();
  return res;
}

/**
 * A heartbeat payload of the shape ingest.service.ts writes into
 * telemetry.payload. Deliberately healthy by default so each detail test can
 * break exactly the one thing it is about, and everything else stays quiet.
 */
function telemetryRow(overrides: Record<string, unknown> = {}, ageMs = 30_000) {
  const recordedAt = new Date(Date.now() - ageMs).toISOString();
  return {
    asset_id: "asset-1",
    recorded_at: recordedAt,
    payload: {
      schemaVersion: 1,
      collector: "agent-node",
      collectedAt: recordedAt,
      hostname: "LAGOS-POS-01",
      network: {
        linkState: "lan",
        gatewayIp: "192.168.1.1",
        dnsServers: ["8.8.8.8"],
        latencyMs: 12,
        packetLossPercent: 0,
        internetReachable: true,
        publicIp: "102.68.77.4",
      },
      storage: {
        volumes: [{ drive: "C:", capacityMb: 512000, freeMb: 256000, freePercent: 50 }],
      },
      security: {
        product: "Microsoft Defender",
        serviceRunning: true,
        protectionEnabled: true,
        definitionsAgeHours: 4,
        firewallProfilesEnabled: ["Domain"],
        status: "healthy",
      },
      printers: [{ name: "HP LaserJet 402", isDefault: true, online: true, queueDepth: 0, faultClass: "none" }],
      enquestDetail: {
        installed: true,
        processRunning: true,
        databaseReachable: true,
        syncServiceRunning: true,
        lastSuccessfulSyncAt: new Date(Date.now() - 120_000).toISOString(),
        recentErrorCount: 0,
        status: "healthy",
      },
      services: [{ name: "Spooler", expectedState: "running", actualState: "running" }],
      ...overrides,
    },
  };
}

beforeEach(() => {
  state.branchMatches = [{ site_id: "site-1", name: "Lagos", slug: "lagos", similarity: 0.9 }];
  state.assets = [{ id: "asset-1", hostname: "LAGOS-POS-01", ip: "192.168.1.11", site_id: "site-1" }];
  state.commandRuns = [];
  state.telemetry = [telemetryRow()];
  state.alerts = [];
  state.incidents = [];
  state.assetHealth = [];
  state.dispatched = [];
  state.dispatchThrows = null;
  state.retireCalls = [];
  state.retireResult = { already_retired: false };
  state.retireError = null;
  state.branchMatchesByQuery = {};
  state.reassignCalls = [];
  state.reassignResult = { already_there: false, to_site_name: "Dubai", alerts_moved: 0 };
  state.reassignError = null;
});

const ACTION_ROUTES = [
  ["/v1/voice/fleet", {}],
  ["/v1/voice/branch", { branch: "Lagos" }],
  ["/v1/voice/detail", { branch: "Lagos", topic: "all" }],
  ["/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" }],
  ["/v1/voice/capabilities", {}],
  ["/v1/voice/playbooks", {}],
  ["/v1/voice/remediate", { branch: "Lagos", action: "spooler" }],
  ["/v1/voice/service", { branch: "Lagos", service: "Spooler", action: "restart" }],
  ["/v1/voice/status", { branch: "Lagos" }],
  ["/v1/voice/open", { branch: "Lagos" }],
  ["/v1/voice/launch", { branch: "Lagos", app: "notepad" }],
  ["/v1/voice/cameras", { branch: "all" }],
] as const;

describe("the shared secret gates every fleet-affecting route", () => {
  for (const [path, body] of ACTION_ROUTES) {
    it(`${path} refuses a missing key`, async () => {
      const res = await call(path, body, null);
      expect(res.statusCode).toBe(401);
    });
    it(`${path} refuses a wrong key`, async () => {
      const res = await call(path, body, "not-the-secret");
      expect(res.statusCode).toBe(401);
    });
  }

  it("does not dispatch anything when the key is wrong", async () => {
    await call("/v1/voice/remediate", { branch: "Lagos", action: "spooler" }, "wrong");
    await call("/v1/voice/service", { branch: "Lagos", service: "Spooler", action: "restart" }, "wrong");
    expect(state.dispatched).toHaveLength(0);
  });
});

describe("every response carries speech for the agent to read", () => {
  for (const [path, body] of ACTION_ROUTES) {
    it(`${path} returns a non-empty speech string`, async () => {
      const res = await call(path, body);
      const parsed = res.json();
      expect(typeof parsed.speech, `${path} -> ${res.body}`).toBe("string");
      expect(parsed.speech.length).toBeGreaterThan(0);
    });
  }
});

describe("dispatch reports SENT, never DONE", () => {
  // The single most dangerous thing this agent could do on stage is announce
  // a fix that has not happened. Dispatch is asynchronous, so the wording
  // must not imply completion and must not promise a callback that no code
  // performs.
  const FORBIDDEN = /\b(fixed|resolved|completed|succeeded|done|I'll report back|working now)\b/i;

  it("run_playbook does not claim completion", async () => {
    const res = await call("/v1/voice/remediate", { branch: "Lagos", action: "spooler" });
    expect(res.json().speech).not.toMatch(FORBIDDEN);
  });

  it("control_service does not claim completion", async () => {
    const res = await call("/v1/voice/service", { branch: "Lagos", service: "Spooler", action: "restart" });
    expect(res.json().speech).not.toMatch(FORBIDDEN);
  });

  it("both point the agent at a status check instead", async () => {
    for (const [path, body] of [
      ["/v1/voice/remediate", { branch: "Lagos", action: "spooler" }],
      ["/v1/voice/service", { branch: "Lagos", service: "Spooler", action: "restart" }],
    ] as const) {
      const res = await call(path, body);
      expect(res.json().speech.toLowerCase()).toContain("status");
    }
  });
});

describe("service control", () => {
  it("dispatches kind service_action at T3 with the requested action", async () => {
    await call("/v1/voice/service", { branch: "Lagos", service: "Spooler", action: "restart" });
    expect(state.dispatched).toHaveLength(1);
    expect(state.dispatched[0]).toMatchObject({ kind: "service_action", serviceName: "Spooler", serviceAction: "restart", tier: "T3" });
  });

  it("rejects a verb that is not start/stop/restart without dispatching", async () => {
    const res = await call("/v1/voice/service", { branch: "Lagos", service: "Spooler", action: "obliterate" });
    expect(res.statusCode).toBe(200);
    expect(state.dispatched).toHaveLength(0);
    expect(res.json().speech).toMatch(/start, stop or restart/i);
  });

  it("asks which service rather than guessing when none is given", async () => {
    await call("/v1/voice/service", { branch: "Lagos", action: "restart" });
    expect(state.dispatched).toHaveLength(0);
  });
});

describe("ambiguous branch names are asked about, never guessed", () => {
  it("names both candidates when similarity is close, and dispatches nothing", async () => {
    state.branchMatches = [
      { site_id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { site_id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
    ];
    const res = await call("/v1/voice/remediate", { branch: "Nyali", action: "spooler" });
    const body = res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe(409);
    expect(body.speech).toContain("Nyali A");
    expect(body.speech).toContain("Nyali B");
    expect(state.dispatched).toHaveLength(0);
  });

  it("does not act on an unknown branch", async () => {
    state.branchMatches = [];
    const res = await call("/v1/voice/service", { branch: "Atlantis", service: "Spooler", action: "restart" });
    expect(res.json().status).toBe(404);
    expect(state.dispatched).toHaveLength(0);
  });
});

describe("conversational outcomes reach the agent as HTTP 200", () => {
  // An agent framework that treats non-2xx as a failed tool call would drop
  // the body, and with it the disambiguation question and the refusal text.
  // These are the two behaviours the system prompt depends on most, so the
  // transport must not be able to swallow them.
  it("a disambiguation is 200 so the body is never discarded", async () => {
    state.branchMatches = [
      { site_id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { site_id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
    ];
    const res = await call("/v1/voice/branch", { branch: "Nyali" });
    expect(res.statusCode).toBe(200);
    expect(res.json().speech).toMatch(/did you mean/i);
  });

  it("a policy refusal is 200 and still carries the reason", async () => {
    const { CommandDeniedError } = await import("../src/orchestrator/orchestrator.service.js");
    state.dispatchThrows = new CommandDeniedError("role l1_support is capped at T2");
    const res = await call("/v1/voice/remediate", { branch: "Lagos", action: "spooler" });
    expect(res.statusCode).toBe(200);
    expect(res.json().ok).toBe(false);
    expect(res.json().refusalReason).toContain("capped at T2");
  });

  it("a bad shared secret stays a real 401 — that one the agent cannot act on", async () => {
    const res = await call("/v1/voice/fleet", {}, "wrong-secret");
    expect(res.statusCode).toBe(401);
  });

  it("marks successful calls ok:true", async () => {
    const res = await call("/v1/voice/playbooks", {});
    expect(res.json().ok).toBe(true);
  });
});

describe("status reporting", () => {
  it("says so plainly when nothing has run", async () => {
    state.commandRuns = [];
    const res = await call("/v1/voice/status", { branch: "Lagos" });
    expect(res.json().total).toBe(0);
    expect(res.json().speech).toMatch(/nothing/i);
  });

  it("counts outcomes and names the first failure", async () => {
    state.commandRuns = [
      { kind: "signed_script", script_id: "restart-spooler", outcome: "success", exit_code: 0, assets: { hostname: "A", site_id: "site-1" } },
      { kind: "signed_script", script_id: "flush-dns", outcome: "failure", exit_code: 1, assets: { hostname: "LAGOS-POS-02", site_id: "site-1" } },
      { kind: "service_action", script_id: null, outcome: "refused", refusal_reason: "matches T6 deny pattern", assets: { hostname: "C", site_id: "site-1" } },
    ];
    const res = await call("/v1/voice/status", { branch: "Lagos" });
    const b = res.json();
    expect(b.succeeded).toBe(1);
    expect(b.failed).toBe(1);
    expect(b.refused).toBe(1);
    expect(b.speech).toContain("LAGOS-POS-02");
  });
});

describe("policy refusals surface as speech, not as a crash", () => {
  it("turns a CommandDeniedError into something the agent can read out", async () => {
    const { CommandDeniedError } = await import("../src/orchestrator/orchestrator.service.js");
    state.dispatchThrows = new CommandDeniedError("role l1_support is capped at T2");
    const res = await call("/v1/voice/remediate", { branch: "Lagos", action: "spooler" });
    expect(res.json().status).toBe(403);
    expect(res.json().speech).toContain("refused by policy");
  });
});

describe("describe_capabilities is computed from the real registries", () => {
  // The point of this route is that it cannot go stale. A hand-written list
  // would pass a "returns speech" test forever while quietly describing a
  // system that no longer exists, so these assert the response against the
  // registries themselves rather than against an expected string.
  it("names every launchable app id and its contract label", async () => {
    const { LAUNCHABLE_APPS, LAUNCHABLE_APP_IDS } = await import("@it-sentinel/contracts");
    const apps = (await call("/v1/voice/capabilities", {})).json().apps as { id: string; label: string }[];

    expect(apps.map((a) => a.id).sort()).toEqual([...LAUNCHABLE_APP_IDS].sort());
    for (const app of apps) {
      expect(app.label).toBe(LAUNCHABLE_APPS[app.id as keyof typeof LAUNCHABLE_APPS]);
    }
  });

  it("names every controllable service id and its contract label", async () => {
    const { CONTROLLABLE_SERVICES, CONTROLLABLE_SERVICE_IDS } = await import("@it-sentinel/contracts");
    const services = (await call("/v1/voice/capabilities", {})).json().services as { id: string; label: string }[];

    expect(services.map((s) => s.id).sort()).toEqual([...CONTROLLABLE_SERVICE_IDS].sort());
    for (const service of services) {
      expect(service.label).toBe(CONTROLLABLE_SERVICES[service.id as keyof typeof CONTROLLABLE_SERVICES]);
    }
  });

  it("offers only playbooks run_playbook will actually match on", async () => {
    // Not a formality: "check endpoint protection" is a real label whose
    // matcher key is "security", so an answer built from labels alone offers
    // a phrase that run_playbook then refuses. Every offer is round-tripped
    // through the route that has to honour it.
    const offered = (await call("/v1/voice/capabilities", {})).json().playbooks as {
      keyword: string;
      label: string;
    }[];
    expect(offered.length).toBeGreaterThan(0);

    for (const { keyword, label } of offered) {
      const res = await call("/v1/voice/remediate", { branch: "Lagos", action: keyword });
      expect(res.json().dispatched, `offered playbook "${label}" (${keyword}) did not dispatch`).toBeGreaterThan(0);
    }
  });

  it("speaks every playbook label exactly once", async () => {
    const body = (await call("/v1/voice/capabilities", {})).json();
    const labels = (body.playbooks as { label: string }[]).map((p) => p.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const label of labels) expect(body.speech).toContain(label);
  });

  it("lists only detail topics get_machine_detail can actually answer", async () => {
    const topics = (await call("/v1/voice/capabilities", {})).json().detailTopics as string[];
    for (const topic of topics) {
      const res = await call("/v1/voice/detail", { branch: "Lagos", topic });
      expect(res.json().topic, `capabilities advertised topic "${topic}"`).toBe(topic);
    }
  });

  it("counts services and apps from the registry rather than hardcoding a number", async () => {
    const { CONTROLLABLE_SERVICES, LAUNCHABLE_APPS } = await import("@it-sentinel/contracts");
    const speech = (await call("/v1/voice/capabilities", {})).json().speech as string;

    expect(speech).toContain(`${new Set(Object.values(CONTROLLABLE_SERVICES)).size} services`);
    expect(speech).toContain(`${new Set(Object.values(LAUNCHABLE_APPS)).size} applications`);
  });

  it("does not read alias duplicates aloud", async () => {
    // "chrome" and "browser" are both valid ids for Google Chrome. Saying it
    // twice is how the answer stops sounding like it knows the fleet.
    const speech = (await call("/v1/voice/capabilities", {})).json().speech as string;
    expect(speech.match(/Google Chrome/g)?.length ?? 0).toBeLessThan(2);
    expect(speech.match(/the Print Spooler/g)?.length ?? 0).toBeLessThan(2);
  });
});

describe("get_machine_detail reads the telemetry payload nothing else reads", () => {
  it("gives real printer numbers, not a status word", async () => {
    state.telemetry = [
      telemetryRow({
        printers: [
          {
            name: "HP LaserJet 402",
            isDefault: true,
            online: false,
            queueDepth: 7,
            faultClass: "network_problem",
            errorState: "Offline",
          },
        ],
      }),
    ];
    const speech = (await call("/v1/voice/detail", { branch: "Lagos", topic: "printer" })).json().speech;
    expect(speech).toContain("HP LaserJet 402");
    expect(speech).toContain("7 jobs");
    expect(speech).toContain("network problem");
  });

  it("gives gateway, latency, packet loss and public address for network", async () => {
    const speech = (await call("/v1/voice/detail", { branch: "Lagos", topic: "network" })).json().speech;
    expect(speech).toContain("192.168.1.1");
    expect(speech).toContain("12 milliseconds");
    expect(speech).toContain("0 percent");
    expect(speech).toContain("102.68.77.4");
  });

  it("names the volume and its free percentage for disk", async () => {
    state.telemetry = [
      telemetryRow({ storage: { volumes: [{ drive: "C:", capacityMb: 512000, freeMb: 20480, freePercent: 4 }] } }),
    ];
    const speech = (await call("/v1/voice/detail", { branch: "Lagos", topic: "disk" })).json().speech;
    expect(speech).toContain("C:");
    expect(speech).toContain("4 percent free");
  });

  it("names the services that are not in their expected state", async () => {
    state.telemetry = [
      telemetryRow({
        services: [
          { name: "Spooler", expectedState: "running", actualState: "stopped" },
          { name: "Dnscache", expectedState: "running", actualState: "running" },
        ],
      }),
    ];
    const speech = (await call("/v1/voice/detail", { branch: "Lagos", topic: "services" })).json().speech;
    expect(speech).toContain("Spooler is stopped");
    expect(speech).not.toContain("Dnscache");
  });

  it("reports Defender state and definition age for security", async () => {
    state.telemetry = [
      telemetryRow({
        security: {
          product: "Microsoft Defender",
          serviceRunning: true,
          protectionEnabled: false,
          definitionsAgeHours: 96,
          tamperProtectionEnabled: false,
          firewallProfilesEnabled: ["Domain"],
          status: "critical",
        },
      }),
    ];
    const speech = (await call("/v1/voice/detail", { branch: "Lagos", topic: "security" })).json().speech;
    expect(speech).toContain("real-time protection is off");
    expect(speech).toContain("96 hours old");
    expect(speech).toContain("tamper protection is off");
  });

  it("reports Enquest sync age and recent errors", async () => {
    state.telemetry = [
      telemetryRow({
        enquestDetail: {
          installed: true,
          processRunning: true,
          databaseReachable: false,
          syncServiceRunning: false,
          lastSuccessfulSyncAt: new Date(Date.now() - 3 * 3600_000).toISOString(),
          recentErrorCount: 5,
          mostCommonError: "database timeout",
          status: "critical",
        },
      }),
    ];
    const speech = (await call("/v1/voice/detail", { branch: "Lagos", topic: "enquest" })).json().speech;
    expect(speech).toContain("sync service is stopped");
    expect(speech).toContain("3 hours ago");
    expect(speech).toContain("5 recent errors");
    expect(speech).toContain("database timeout");
  });

  it("defaults to all and leads with whatever is actually wrong", async () => {
    state.telemetry = [
      telemetryRow({ services: [{ name: "Spooler", expectedState: "running", actualState: "stopped" }] }),
    ];
    const body = (await call("/v1/voice/detail", { branch: "Lagos" })).json();
    expect(body.topic).toBe("all");
    expect(body.speech).toContain("Spooler is stopped");
  });

  it("says so plainly when everything is fine rather than inventing a fault", async () => {
    const body = (await call("/v1/voice/detail", { branch: "Lagos", topic: "all" })).json();
    expect(body.speech).toMatch(/nothing stands out/i);
    expect(body.reports.every((r: any) => r.healthy)).toBe(true);
  });
});

describe("get_machine_detail never passes stale data off as current", () => {
  // The failure that matters here: an operator hears "latency is 12
  // milliseconds", acts on it, and the reading came from an hour ago. Saying
  // nothing about age is an implicit claim of freshness, so the age has to
  // lead the sentence rather than trail it.
  it("flags telemetry older than five minutes and says how old it is", async () => {
    state.telemetry = [telemetryRow({}, 47 * 60_000)];
    const body = (await call("/v1/voice/detail", { branch: "Lagos", topic: "network" })).json();

    expect(body.stale).toBe(true);
    expect(body.speech).toMatch(/not live/i);
    expect(body.speech).toContain("47 minutes old");
    expect(body.speech.indexOf("not live")).toBeLessThan(body.speech.indexOf("12 milliseconds"));
  });

  it("does not flag a heartbeat from thirty seconds ago", async () => {
    const body = (await call("/v1/voice/detail", { branch: "Lagos", topic: "network" })).json();
    expect(body.stale).toBe(false);
    expect(body.speech).not.toMatch(/not live/i);
  });

  it("admits there is no telemetry rather than reporting an empty machine as healthy", async () => {
    state.telemetry = [];
    const body = (await call("/v1/voice/detail", { branch: "Lagos", topic: "all" })).json();

    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
    expect(body.speech).toMatch(/no detail to give you/i);
    expect(body.speech).not.toMatch(/healthy|nothing stands out/i);
  });

  it("says the branch has no machines when none are registered", async () => {
    state.assets = [];
    const body = (await call("/v1/voice/detail", { branch: "Lagos", topic: "disk" })).json();
    expect(body.status).toBe(404);
  });
});

describe("get_machine_detail asks about an ambiguous branch like every other route", () => {
  it("names both candidates and reports on neither", async () => {
    state.branchMatches = [
      { site_id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { site_id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
    ];
    const res = await call("/v1/voice/detail", { branch: "Nyali", topic: "printer" });
    const body = res.json();

    expect(res.statusCode).toBe(200);
    expect(body.status).toBe(409);
    expect(body.speech).toContain("Nyali A");
    expect(body.speech).toContain("Nyali B");
    expect(body.reports).toBeUndefined();
  });

  it("does not answer for an unknown branch", async () => {
    state.branchMatches = [];
    const body = (await call("/v1/voice/detail", { branch: "Atlantis" })).json();
    expect(body.status).toBe(404);
  });

  it("offers the topics it has instead of guessing at an unknown one", async () => {
    const body = (await call("/v1/voice/detail", { branch: "Lagos", topic: "cpu temperature" })).json();
    expect(body.speech).toMatch(/printers, network, disk, services, security or Enquest/i);
    expect(body.reports).toBeUndefined();
  });
});

describe("the routes never under-report what they can do", () => {
  // The failure this guards is quieter than a crash: the run_playbook
  // fallback used to be a hand-written sentence that had fallen behind the
  // table above it, so the agent told operators it could not send a test
  // print when the script, the manifest and the mapping all existed.
  it("the run_playbook fallback offers every playbook the table maps", async () => {
    const offered = (await call("/v1/voice/capabilities", {})).json().playbooks as {
      keyword: string;
      label: string;
    }[];
    const speech = (await call("/v1/voice/remediate", { branch: "Lagos", action: "make coffee" })).json().speech;

    for (const { label } of offered) {
      expect(speech, `run_playbook's fallback does not mention "${label}"`).toContain(label);
    }
    expect(speech).toContain("send a test print");
    expect(state.dispatched).toHaveLength(0);
  });

  it("list_playbooks, capabilities and the fallback agree on the list", async () => {
    const fromList = (await call("/v1/voice/playbooks", {})).json().playbooks as string[];
    const fromCapabilities = (
      (await call("/v1/voice/capabilities", {})).json().playbooks as { label: string }[]
    ).map((p) => p.label);
    expect(fromCapabilities.sort()).toEqual([...fromList].sort());
  });
});

describe("auth failures carry the same body shape as every other response", () => {
  // handle() puts `ok` on everything it returns; the preHandler short-circuits
  // before handle() runs, so without this these two were the only responses
  // where a caller branching on `ok` got undefined.
  it("a wrong key is ok:false with its status in the body", async () => {
    const res = await call("/v1/voice/fleet", {}, "wrong-secret");
    expect(res.statusCode).toBe(401);
    expect(res.json()).toMatchObject({ ok: false, status: 401 });
    expect(res.json().speech.length).toBeGreaterThan(0);
  });

  it("an unconfigured server is ok:false with its status in the body", async () => {
    const { env } = await import("../src/env.js");
    const configured = env.VOICE_WEBHOOK_SECRET;
    (env as any).VOICE_WEBHOOK_SECRET = undefined;
    try {
      const res = await call("/v1/voice/capabilities", {});
      expect(res.statusCode).toBe(503);
      expect(res.json()).toMatchObject({ ok: false, status: 503 });
    } finally {
      (env as any).VOICE_WEBHOOK_SECRET = configured;
    }
  });
});

/**
 * A resolved incident of the shape recurrence.service.ts reads back, with
 * the branch embedded the way PostgREST returns a to-one join.
 */
function resolvedIncident(branch: string, fix: string | null, success: boolean | null, assetId = "asset-1") {
  return {
    ticket_ref: `TKT-${Math.random().toString(36).slice(2, 7)}`,
    title: `Enquest critical on ${branch}`,
    resolution_summary: fix,
    resolution_success: success,
    opened_at: new Date(Date.now() - 86_400_000).toISOString(),
    asset_id: assetId,
    fingerprint: `enquest_sync:${assetId}`,
    sites: { name: branch },
  };
}

/** asset_health as the branch route reads it, red on Enquest. */
function criticalHealthRow() {
  return {
    status: "critical",
    online: true,
    ram_usage: 40,
    disk_free_percent: 50,
    printer_status: "healthy",
    enquest_status: "critical",
    endpoint_security_status: "healthy",
    assets: { hostname: "LAGOS-POS-01", site_id: "site-1" },
  };
}

describe("get_recurrence answers across branches, not just this machine", () => {
  // The requirement this route exists for: once a similar issue turns up at
  // a different branch, the agent should already know what fixed it. A
  // per-asset fingerprint can only ever answer "not on this machine", so
  // what is asserted here is that history from OTHER branches reaches the
  // answer at all.
  it("reports history recorded at other branches", async () => {
    state.incidents = [
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Mombasa", "restart the Enquest sync service", true, "asset-7"),
    ];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.timesSeen).toBe(3);
    expect(body.speech).toContain("Nairobi");
    expect(body.speech).toContain("Mombasa");
    expect(body.speech).toContain("restart the Enquest sync service");
  });

  it("says plainly when the fault is new to this branch but not to the fleet", async () => {
    state.incidents = [resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9")];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.timesSeenAtBranch).toBe(0);
    expect(body.speech).toMatch(/first time at Lagos/i);
  });

  it("counts the occurrences at the asking branch separately", async () => {
    state.incidents = [
      resolvedIncident("Lagos", "restart the Enquest sync service", true),
      resolvedIncident("Lagos", "restart the Enquest sync service", true),
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
    ];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();
    expect(body.timesSeenAtBranch).toBe(2);
    expect(body.speech).toContain("here at Lagos");
  });
});

describe("get_recurrence never invents history it does not have", () => {
  // Overclaiming here is worse than a modest answer: the operator acts on
  // the number, and a fabricated one sends them to the wrong fix with
  // confidence.
  it("admits there is no history rather than implying a first-time fault is known", async () => {
    state.incidents = [];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.timesSeen).toBe(0);
    expect(body.suggestedFix).toBeNull();
    expect(body.speech).toMatch(/no resolved history/i);
    expect(body.speech).toMatch(/first time/i);
    expect(body.speech).not.toMatch(/\d+ percent/);
  });

  it("does not quote a percentage off a handful of attempts", async () => {
    state.incidents = [
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
    ];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.speech).not.toMatch(/percent/);
    expect(body.speech).toMatch(/tried 2 times and worked every time/i);
  });

  it("quotes a rate only once there are enough graded attempts to mean something", async () => {
    state.incidents = [
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Mombasa", "restart the Enquest sync service", true, "asset-7"),
      resolvedIncident("Mombasa", "restart the Enquest sync service", false, "asset-7"),
    ];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.suggestedFixHistory).toMatchObject({ attempts: 4, succeeded: 3 });
    expect(body.speech).toContain("worked 3 of the 4 times");
    expect(body.speech).toContain("75 percent");
  });

  it("says there is nothing proven to repeat when no recorded fix worked", async () => {
    state.incidents = [
      resolvedIncident("Nairobi", "rebooted the machine", false, "asset-9"),
      resolvedIncident("Mombasa", "rebooted the machine", false, "asset-7"),
    ];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.suggestedFix).toBeNull();
    expect(body.speech).toMatch(/nothing proven to repeat/i);
  });

  it("rates the suggested fix on its own record, not on the class average", async () => {
    // Two different fixes with different track records. Averaging them
    // would attach the failing fix's misses to the one being recommended.
    state.incidents = [
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Mombasa", "rebooted the machine", false, "asset-7"),
      resolvedIncident("Mombasa", "rebooted the machine", false, "asset-7"),
    ];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "enquest" })).json();

    expect(body.suggestedFix).toBe("restart the Enquest sync service");
    expect(body.suggestedFixHistory).toMatchObject({ attempts: 1, succeeded: 1 });
    expect(body.successRatePercent).toBe(33);
  });
});

describe("get_recurrence resolves what to look up the way an operator would ask", () => {
  it("falls back to the branch's newest open alert when no check is named", async () => {
    state.alerts = [{ fingerprint: "endpoint_security:asset-1", title: "Endpoint protection critical on LAGOS-POS-01" }];
    state.incidents = [];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos" })).json();

    expect(body.checkType).toBe("endpoint_security");
    expect(body.liveFault).toContain("Endpoint protection critical");
  });

  it("asks which check rather than guessing when nothing is alerting", async () => {
    state.alerts = [];
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos" })).json();

    expect(body.timesSeen).toBeUndefined();
    expect(body.speech).toMatch(/nothing is alerting/i);
    expect(body.speech).toContain("the Enquest sync check");
  });

  it("offers the checks it has instead of pattern-matching an unknown one", async () => {
    const body = (await call("/v1/voice/recurrence", { branch: "Lagos", checkType: "cosmic rays" })).json();
    expect(body.timesSeen).toBeUndefined();
    expect(body.speech).toMatch(/cosmic rays/);
    expect(body.checks.length).toBeGreaterThan(0);
  });

  it("asks about an ambiguous branch like every other route", async () => {
    state.branchMatches = [
      { site_id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { site_id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
    ];
    const res = await call("/v1/voice/recurrence", { branch: "Nyali", checkType: "enquest" });
    expect(res.statusCode).toBe(200);
    expect(res.json().status).toBe(409);
    expect(res.json().timesSeen).toBeUndefined();
  });
});

describe("get_branch_status surfaces recurrence at the moment the fault is reported", () => {
  // The most useful moment for "this is the fourth time" is when the fault
  // is first spoken, not two turns later if the operator thinks to ask.
  it("appends the history and the previous fix to a fault report", async () => {
    state.assetHealth = [criticalHealthRow()];
    state.alerts = [{ fingerprint: "enquest_sync:asset-1", title: "Enquest critical on LAGOS-POS-01" }];
    state.incidents = [
      resolvedIncident("Nairobi", "restart the Enquest sync service", true, "asset-9"),
      resolvedIncident("Mombasa", "restart the Enquest sync service", true, "asset-7"),
    ];

    const body = (await call("/v1/voice/branch", { branch: "Lagos" })).json();
    expect(body.speech).toContain("Enquest down");
    expect(body.speech).toMatch(/isn't new/i);
    expect(body.speech).toContain("restart the Enquest sync service");
    expect(body.recurrence.timesSeen).toBe(2);
  });

  it("stays quiet about history when there is none, rather than padding the answer", async () => {
    state.assetHealth = [criticalHealthRow()];
    state.alerts = [{ fingerprint: "enquest_sync:asset-1", title: "Enquest critical on LAGOS-POS-01" }];
    state.incidents = [];

    const body = (await call("/v1/voice/branch", { branch: "Lagos" })).json();
    expect(body.speech).not.toMatch(/isn't new|last fix|nothing proven/i);
    expect(body.recurrence.timesSeen).toBe(0);
  });
});

describe("retiring a machine is two-step, and never guesses which one", () => {
  // The only destructive-ish route here, and speech recognition mishears
  // hostnames constantly — so a single misheard turn must not take a machine
  // off the board mid-demo.
  it("asks for confirmation instead of retiring on the first turn", async () => {
    const res = await call("/v1/voice/retire", { branch: "Lagos" });
    expect(res.json().requiresConfirmation).toBe(true);
    expect(res.json().speech.toLowerCase()).toContain("confirm");
    expect(state.retireCalls).toHaveLength(0);
  });

  it("retires only once confirm is explicitly true", async () => {
    const res = await call("/v1/voice/retire", { branch: "Lagos", confirm: true });
    expect(state.retireCalls).toHaveLength(1);
    expect(state.retireCalls[0]).toMatchObject({ p_asset_id: "asset-1", p_actor_id: "operator-1" });
    expect(res.json().retired).toBe(true);
  });

  it("refuses to pick when the branch has several machines and none is named", async () => {
    state.assets = [
      { id: "a1", hostname: "LAGOS-POS-01", site_id: "site-1" },
      { id: "a2", hostname: "LAGOS-POS-02", site_id: "site-1" },
    ];
    const res = await call("/v1/voice/retire", { branch: "Lagos", confirm: true });
    expect(res.json().status).toBe(409);
    expect(state.retireCalls).toHaveLength(0);
  });

  it("refuses when a hostname hint matches more than one machine", async () => {
    state.assets = [
      { id: "a1", hostname: "LAGOS-POS-01", site_id: "site-1" },
      { id: "a2", hostname: "LAGOS-POS-02", site_id: "site-1" },
    ];
    const res = await call("/v1/voice/retire", { branch: "Lagos", hostname: "LAGOS-POS", confirm: true });
    expect(res.json().status).toBe(409);
    expect(state.retireCalls).toHaveLength(0);
  });

  it("targets the named machine when the hint is unambiguous", async () => {
    state.assets = [
      { id: "a1", hostname: "LAGOS-POS-01", site_id: "site-1" },
      { id: "a2", hostname: "LAGOS-TILL-09", site_id: "site-1" },
    ];
    await call("/v1/voice/retire", { branch: "Lagos", hostname: "TILL", confirm: true });
    expect(state.retireCalls[0]).toMatchObject({ p_asset_id: "a2" });
  });

  it("reports an already-retired machine plainly rather than as a fresh retirement", async () => {
    state.retireResult = { already_retired: true };
    const res = await call("/v1/voice/retire", { branch: "Lagos", confirm: true });
    expect(res.json().alreadyRetired).toBe(true);
    expect(res.json().retired).toBeUndefined();
  });

  it("surfaces the database's role check as a spoken refusal, not a crash", async () => {
    // retire_asset raises 42501 when the operator's role is below l3.
    state.retireError = { code: "42501", message: "operator may not retire assets" };
    const res = await call("/v1/voice/retire", { branch: "Lagos", confirm: true });
    expect(res.json().status).toBe(403);
    expect(res.json().speech.toLowerCase()).toContain("authorised");
  });

  it("is gated by the shared secret like every other route", async () => {
    const res = await call("/v1/voice/retire", { branch: "Lagos", confirm: true }, "wrong");
    expect(res.statusCode).toBe(401);
    expect(state.retireCalls).toHaveLength(0);
  });
});

describe("moving a machine to another branch is two-step, and resolves both ends", () => {
  /** Lagos and Dubai as two distinct branches, keyed by what is spoken. */
  function twoBranches() {
    state.branchMatchesByQuery = {
      Lagos: [{ site_id: "site-1", name: "Lagos", slug: "lagos", similarity: 0.95 }],
      Dubai: [{ site_id: "site-2", name: "Dubai", slug: "dubai", similarity: 0.95 }],
    };
  }

  beforeEach(twoBranches);

  it("asks for confirmation instead of moving on the first turn", async () => {
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai" });
    expect(res.json().requiresConfirmation).toBe(true);
    // Both ends named in the prompt: mishearing one branch name is the whole
    // risk this second turn exists to catch.
    expect(res.json().speech).toContain("Lagos");
    expect(res.json().speech).toContain("Dubai");
    expect(state.reassignCalls).toHaveLength(0);
  });

  it("moves only once confirm is explicitly true, and passes both ids", async () => {
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(state.reassignCalls).toHaveLength(1);
    expect(state.reassignCalls[0]).toMatchObject({ p_asset_id: "asset-1", p_site_id: "site-2", p_actor_id: "operator-1" });
    expect(res.json().reassigned).toBe(true);
  });

  it("says the agent's config is now stale, because nothing else will", async () => {
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(res.json().speech).toContain("SENTINEL_BRANCH_SLUG");
  });

  it("mentions the open alerts that travelled with the machine", async () => {
    state.reassignResult = { already_there: false, to_site_name: "Dubai", alerts_moved: 2 };
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(res.json().alertsMoved).toBe(2);
    expect(res.json().speech).toMatch(/2 open alerts moved/);
  });

  it("asks which branch when none was given, rather than guessing one", async () => {
    const res = await call("/v1/voice/reassign", { branch: "Lagos" });
    expect(res.json().speech).toMatch(/which branch/i);
    expect(state.reassignCalls).toHaveLength(0);
  });

  it("refuses to pick when the branch has several machines and none is named", async () => {
    state.assets = [
      { id: "a1", hostname: "LAGOS-POS-01", site_id: "site-1" },
      { id: "a2", hostname: "LAGOS-POS-02", site_id: "site-1" },
    ];
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(res.json().status).toBe(409);
    expect(state.reassignCalls).toHaveLength(0);
  });

  it("refuses when a hostname hint matches more than one machine", async () => {
    state.assets = [
      { id: "a1", hostname: "LAGOS-POS-01", site_id: "site-1" },
      { id: "a2", hostname: "LAGOS-POS-02", site_id: "site-1" },
    ];
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", hostname: "LAGOS-POS", confirm: true });
    expect(res.json().status).toBe(409);
    expect(state.reassignCalls).toHaveLength(0);
  });

  it("targets the named machine when the hint is unambiguous", async () => {
    state.assets = [
      { id: "a1", hostname: "LAGOS-POS-01", site_id: "site-1" },
      { id: "a2", hostname: "LAGOS-TILL-09", site_id: "site-1" },
    ];
    await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", hostname: "TILL", confirm: true });
    expect(state.reassignCalls[0]).toMatchObject({ p_asset_id: "a2" });
  });

  it("asks about an ambiguous destination rather than moving to a coin-flip", async () => {
    state.branchMatchesByQuery.Nyali = [
      { site_id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { site_id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
    ];
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Nyali", confirm: true });
    expect(res.json().status).toBe(409);
    expect(state.reassignCalls).toHaveLength(0);
  });

  it("says a machine is already there without asking to confirm a no-op", async () => {
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Lagos" });
    expect(res.json().alreadyThere).toBe(true);
    expect(res.json().requiresConfirmation).toBeUndefined();
    expect(state.reassignCalls).toHaveLength(0);
  });

  it("reports the function's own idempotent answer plainly", async () => {
    state.reassignResult = { already_there: true, to_site_name: "Dubai", alerts_moved: 0 };
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(res.json().alreadyThere).toBe(true);
    expect(res.json().reassigned).toBeUndefined();
  });

  it("surfaces the two-ended role check as a spoken refusal naming both branches", async () => {
    state.reassignError = { code: "42501", message: "operator may not move assets out of site" };
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(res.json().status).toBe(403);
    expect(res.json().speech).toContain("Lagos");
    expect(res.json().speech).toContain("Dubai");
  });

  it("explains a hostname collision as a situation, not as a constraint violation", async () => {
    state.reassignError = { code: "23505", message: "Dubai already has a machine called LAGOS-POS-01" };
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true });
    expect(res.json().status).toBe(409);
    expect(res.json().speech).toContain("LAGOS-POS-01");
    expect(res.json().speech).not.toMatch(/constraint|23505/);
  });

  it("is gated by the shared secret like every other route", async () => {
    const res = await call("/v1/voice/reassign", { branch: "Lagos", toBranch: "Dubai", confirm: true }, "wrong");
    expect(res.statusCode).toBe(401);
    expect(state.reassignCalls).toHaveLength(0);
  });
});
