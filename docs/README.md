# IT Sentinel — Documentation

This is the documentation for **IT Sentinel**, the Sentinel Global IT Operations Command Center. Start here.

## Read in this order if you're new

1. **[01-overview.md](./01-overview.md)** — what this is, why it exists, the loop it implements
2. **[02-getting-started.md](./02-getting-started.md)** — get it running on your machine
3. **[03-architecture.md](./03-architecture.md)** — how the pieces fit together
4. **[04-database.md](./04-database.md)** — the schema, every table, every migration
5. **[05-security-model.md](./05-security-model.md)** — the tier system, the deny list, the credential vault — read this before touching anything security-related
6. **[06-control-plane-api.md](./06-control-plane-api.md)** — every HTTP endpoint, request/response shapes
7. **[07-agents.md](./07-agents.md)** — the three telemetry collectors and how elevation works
8. **[08-relay-and-remote-access.md](./08-relay-and-remote-access.md)** — the RFB engine, VNC auth, noVNC viewer
9. **[09-web-console.md](./09-web-console.md)** — the frontend, screen by screen
10. **[10-sentinel-agent.md](./10-sentinel-agent.md)** — the AI harness, tools, and why the model comes last
11. **[11-scripts-library.md](./11-scripts-library.md)** — the signed playbook system
12. **[12-testing-and-verification.md](./12-testing-and-verification.md)** — what's proven, how, and where to find it
13. **[13-deployment.md](./13-deployment.md)** — running this for real, environment variables, secrets
14. **[14-status-and-roadmap.md](./14-status-and-roadmap.md)** — what's built, what's stubbed, what's not started, and why
15. **[15-hackathon-demo-runbook.md](./15-hackathon-demo-runbook.md)** — everything needed to get laptops live and run the demo, top to bottom
16. **[16-elevenlabs-agent-config.md](./16-elevenlabs-agent-config.md)** — the voice agent's system prompt, webhook tools, and dashboard setup — the single source of truth for its configuration
17. **[17-fault-simulation.md](./17-fault-simulation.md)** — inducing and reversing real faults on a branch laptop for demo/testing purposes
18. **[18-decommissioning.md](./18-decommissioning.md)** — getting a machine cleanly out of the fleet (no agent, no telemetry, no remote access, no firewall hole left)
19. **[19-enrollment.md](./19-enrollment.md)** — getting a machine into the fleet: pick a branch, copy one command

## Operating it — the runbooks

These five are written for the person holding the laptop, not the person reading the source.

15. **[15-hackathon-demo-runbook.md](./15-hackathon-demo-runbook.md)** — seven laptops live and the demo run, in order; each step verifies the one before it
16. **[16-elevenlabs-agent-config.md](./16-elevenlabs-agent-config.md)** — the voice agent's tools, prompt and system prompt, and the two things that most often break voice on stage
17. **[17-fault-simulation.md](./17-fault-simulation.md)** — inducing a real, reversible fault on a branch laptop, and putting it back
18. **[18-decommissioning.md](./18-decommissioning.md)** — getting a machine completely out of the fleet: no agent, no telemetry, nothing left behind
19. **[19-enrollment.md](./19-enrollment.md)** — getting a machine in, from the `/enroll` page. **§5.2 documents the unauthenticated-heartbeat gap in full**

The project [`README.md`](../README.md) is the public entry point and links back to every document here.

## The one-paragraph version

Forty-four branches, one shared VNC password, and an IT team that only learns something's broken when a branch calls. IT Sentinel replaces that with a live fleet dashboard, telemetry from every machine, brokered remote access where the operator never sees a credential, elevated PowerShell execution locked behind a deny-list and hash-pinning that's been adversarially tested, voice control that resolves ambiguous branch names correctly, and an AI assistant whose capabilities are enforced by code, not by a prompt. TightVNC keeps running unmodified on every branch PC; nothing in this system copies its source.

## Where the source of truth actually lives

This documentation describes the system as built. If something here and the code disagree, **the code is right** — these docs should be kept in sync, but treat a discrepancy as a docs bug, not a spec to enforce. The single most authoritative files in the repo, if you only trust three things:

- [`packages/contracts/src/heartbeat.ts`](../packages/contracts/src/heartbeat.ts) — the wire contract every collector must match
- [`apps/agent-node/src/exec/executor.ts`](../apps/agent-node/src/exec/executor.ts) — the only place a command becomes a process on a machine
- [`packages/db/migrations/`](../packages/db/migrations/) — the schema, applied in order, is the database's actual history
