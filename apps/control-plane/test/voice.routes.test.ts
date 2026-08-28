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
  branchMatches: [{ id: "site-1", name: "Lagos", slug: "lagos", similarity: 0.9 }] as any[],
  assets: [{ id: "asset-1", hostname: "LAGOS-POS-01", ip: "192.168.1.11", site_id: "site-1" }] as any[],
  operatorRow: { operator_id: "operator-1" } as any,
  commandRuns: [] as any[],
  telemetry: [] as any[],
  dispatched: [] as any[],
  dispatchThrows: null as Error | null,
}));

vi.mock("../src/db.js", () => {
  function table(name: string) {
    const rows = () => {
      if (name === "assets") return state.assets;
      if (name === "site_access") return [state.operatorRow];
      if (name === "command_runs") return state.commandRuns;
      if (name === "telemetry") return state.telemetry;
      if (name === "asset_health") return [];
      return [];
    };
    const chain: any = {
      select: () => chain,
      eq: () => chain,
      in: () => chain,
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
      rpc: async (fn: string) => {
        if (fn === "resolve_branch_by_voice") return { data: state.branchMatches, error: null };
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
  state.branchMatches = [{ id: "site-1", name: "Lagos", slug: "lagos", similarity: 0.9 }];
  state.assets = [{ id: "asset-1", hostname: "LAGOS-POS-01", ip: "192.168.1.11", site_id: "site-1" }];
  state.commandRuns = [];
  state.telemetry = [telemetryRow()];
  state.dispatched = [];
  state.dispatchThrows = null;
});

const ACTION_ROUTES = [
  ["/v1/voice/fleet", {}],
  ["/v1/voice/branch", { branch: "Lagos" }],
  ["/v1/voice/detail", { branch: "Lagos", topic: "all" }],
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
      { id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
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
      { id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
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
      { id: "s1", name: "Nyali A", slug: "nyali-a", similarity: 0.81 },
      { id: "s2", name: "Nyali B", slug: "nyali-b", similarity: 0.79 },
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
