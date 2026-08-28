import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Regenerates a .manifest.json next to every .ps1 in library/, with the
 * SHA-256 the executor's hash-pinning check (apps/agent-node/src/exec/
 * executor.ts) verifies at dispatch time. Run this after any edit to a
 * script — the executor refuses to run a script whose disk hash doesn't
 * match its manifest, by design (see the plan's "How elevation is
 * constrained").
 */

interface ScriptMeta {
  slug: string;
  category: "printer" | "network" | "enquest" | "windows" | "security";
  name: string;
  tier: "T2" | "T3" | "T4" | "T5";
  timeoutSeconds: number;
  idempotent: boolean;
  rollbackDefined: boolean;
  requiredApprovals: number;
}

const REGISTRY: ScriptMeta[] = [
  { slug: "restart-spooler", category: "printer", name: "Restart Print Spooler", tier: "T3", timeoutSeconds: 30, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "clear-print-queue", category: "printer", name: "Clear Print Queue", tier: "T3", timeoutSeconds: 30, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "test-print", category: "printer", name: "Test Print", tier: "T2", timeoutSeconds: 20, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "flush-dns", category: "network", name: "Flush DNS", tier: "T3", timeoutSeconds: 15, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "ping-gateway", category: "network", name: "Ping Gateway", tier: "T2", timeoutSeconds: 20, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "enquest-check-services", category: "enquest", name: "Check Enquest Services", tier: "T2", timeoutSeconds: 20, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "windows-system-health", category: "windows", name: "System Health", tier: "T2", timeoutSeconds: 20, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
  { slug: "defender-status", category: "security", name: "Defender Status", tier: "T2", timeoutSeconds: 20, idempotent: true, rollbackDefined: false, requiredApprovals: 0 },
];

const LIB_DIR = join(import.meta.dirname, "library");

for (const meta of REGISTRY) {
  const scriptPath = `${meta.slug}.ps1`;
  const fullPath = join(LIB_DIR, scriptPath);
  const content = readFileSync(fullPath);
  const sha256 = createHash("sha256").update(content).digest("hex");

  const manifest = {
    scriptId: meta.slug,
    name: meta.name,
    category: meta.category,
    tier: meta.tier,
    version: "1.0.0",
    sha256,
    scriptPath,
    timeoutSeconds: meta.timeoutSeconds,
    idempotent: meta.idempotent,
    rollbackDefined: meta.rollbackDefined,
    requiredApprovals: meta.requiredApprovals,
  };

  writeFileSync(join(LIB_DIR, `${meta.slug}.manifest.json`), JSON.stringify(manifest, null, 2) + "\n");
  console.log(`${meta.slug}: ${sha256}`);
}

console.log(`\nGenerated ${REGISTRY.length} manifests.`);
