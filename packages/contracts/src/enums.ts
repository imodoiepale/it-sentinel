import { z } from "zod";

/** Coarse status used across every check surfaced to the dashboard. Never collapse "stale" into "healthy". */
export const HealthStatus = z.enum(["healthy", "warning", "critical", "unknown", "stale"]);
export type HealthStatus = z.infer<typeof HealthStatus>;

export const AssetType = z.enum([
  "pos",
  "server",
  "workstation",
  "printer",
  "switch",
  "ap",
  "ups",
  "nvr",
  "camera",
]);
export type AssetType = z.infer<typeof AssetType>;

export const CollectorKind = z.enum(["agent-node", "agent-dotnet", "agent-less"]);
export type CollectorKind = z.infer<typeof CollectorKind>;

export const PrinterFaultClass = z.enum([
  "none",
  "pc_problem",
  "network_problem",
  "physical_printer_problem",
  "driver_problem",
]);
export type PrinterFaultClass = z.infer<typeof PrinterFaultClass>;

/**
 * Action tiers T0-T6, enforced in the executor — never inferred from a prompt.
 *
 * T4 is the Operator Console tier: the only one that runs arbitrary
 * PowerShell rather than an allowlisted cmdlet or a hash-pinned script. It
 * buys that reach by requiring the operator to re-enter their password
 * (POST /v1/auth/reauth), not by relaxing anything — T6 still denies at T4.
 */
export const ActionTier = z.enum(["T0", "T1", "T2", "T3", "T4", "T5", "T6"]);
export type ActionTier = z.infer<typeof ActionTier>;

export const OperatorRole = z.enum([
  "l1_support",
  "l2_support",
  "l3_sysadmin",
  "security_admin",
  "it_manager",
  "auditor",
]);
export type OperatorRole = z.infer<typeof OperatorRole>;
