# agent-dotnet

**Status: scaffolded, not built or tested.** The .NET 8 SDK is not installed
in this environment (`dotnet --version` → command not found), and per the
plan's honesty rule this is stated plainly rather than presented as working.

## What's here

`src/Program.cs` is a real, from-scratch Worker Service skeleton targeting
the same wire contract as agent-node and agent-less
(`packages/contracts/src/heartbeat.ts`) — it is not copied from anywhere,
and it has never been compiled. Treat it as a starting point, not a
verified artifact.

## To pick this up

1. Install the .NET 8 SDK: https://dotnet.microsoft.com/download/dotnet/8.0
2. `dotnet build` — fix whatever the compiler finds; nothing here has been
   through a compiler yet.
3. Port the same collectors agent-node's `collect.ps1` implements, but
   natively via `System.Management` (CIM) instead of shelling out to
   PowerShell — this is the whole reason agent-dotnet exists per the plan:
   "best native fidelity... ETW event logs, ServiceController."
4. Reuse `packages/contracts`'s JSON shape exactly — generate a matching
   C# record type (or hand-write one) and add a contract test that
   round-trips a fixture through both the TypeScript Zod schema and the C#
   serializer, the same way `packages/contracts/test/heartbeat.test.ts`
   tests the Node/PowerShell side.
5. Elevated execution (the `agent-node/src/exec` equivalent) should port
   the deny-list and tier-allowlist logic 1:1 — those two files
   (`deny-list.ts`, `tier-resolver.ts`) are the actual security boundary,
   not the language they're written in, and the adversarial test suite in
   `apps/agent-node/test/executor.adversarial.test.ts` is the spec for
   what agent-dotnet's equivalent suite must also prove.
