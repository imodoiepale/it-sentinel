import { z } from "zod";
import { ActionTier } from "./enums.js";

/**
 * Contract for a command dispatched to an agent via the pgmq `agent_commands`
 * queue (store-and-forward across WAN drops), and for the result the agent
 * reports back. Every field the executor needs to make an allow/deny decision
 * travels in this envelope — the agent never receives a bare shell string.
 */

export const CommandKind = z.enum(["signed_script", "adhoc_powershell", "service_action"]);
export type CommandKind = z.infer<typeof CommandKind>;

export const ServiceAction = z.enum(["start", "stop", "restart"]);

export const CommandRequest = z.object({
  commandId: z.string().uuid(),
  assetId: z.string().uuid(),
  ticketRef: z.string().optional(),
  operatorId: z.string().uuid(),
  tier: ActionTier,
  kind: CommandKind,

  // signed_script
  scriptId: z.string().optional(),
  scriptVersion: z.string().optional(),
  scriptSha256: z.string().length(64).optional(),
  args: z.record(z.string(), z.string()).default({}),

  // adhoc_powershell — parsed and classified before dispatch, never opaque.
  adhocCommand: z.string().optional(),

  // service_action
  serviceName: z.string().optional(),
  serviceAction: ServiceAction.optional(),

  timeoutSeconds: z.number().int().positive().max(600).default(60),
  approvals: z
    .array(z.object({ operatorId: z.string().uuid(), approvedAt: z.string().datetime() }))
    .default([]),
});
export type CommandRequest = z.infer<typeof CommandRequest>;

export const CommandResult = z.object({
  commandId: z.string().uuid(),
  assetId: z.string().uuid(),
  startedAt: z.string().datetime(),
  finishedAt: z.string().datetime(),
  durationMs: z.number().int().nonnegative(),
  exitCode: z.number().int(),
  stdout: z.string().max(200_000).default(""),
  stderr: z.string().max(200_000).default(""),
  outcome: z.enum(["success", "failure", "timeout", "refused"]),
  refusalReason: z.string().optional(),
  verification: z
    .object({
      checked: z.boolean(),
      passed: z.boolean().optional(),
      detail: z.string().optional(),
    })
    .optional(),
});
export type CommandResult = z.infer<typeof CommandResult>;
