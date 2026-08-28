import { randomUUID } from "node:crypto";
import { CommandRequest, CommandResult } from "@it-sentinel/contracts";
import { db } from "../db.js";
import { evaluateCommandPolicy } from "../policy/policy.service.js";

/**
 * Dispatches CommandRequest envelopes onto the per-agent pgmq queue
 * (store-and-forward: survives a WAN drop, delivered when the branch
 * reconnects) and records the run. This is the ONLY path that gets a
 * command in front of an agent — voice, playbooks, and the terminal UI all
 * funnel through here so every elevated action goes through one policy
 * check and one audit trail, never a side channel.
 */

const MAX_BLAST_RADIUS_BEFORE_T5_PROMOTION = 5;

export class CommandDeniedError extends Error {
  constructor(public readonly reason: string) {
    super(`command denied: ${reason}`);
  }
}

export async function dispatchCommand(args: {
  assetIds: string[];
  operatorId: string;
  ticketRef?: string;
  kind: CommandRequest["kind"];
  scriptId?: string;
  scriptVersion?: string;
  scriptSha256?: string;
  cmdArgs?: Record<string, string>;
  adhocCommand?: string;
  serviceName?: string;
  serviceAction?: "start" | "stop" | "restart";
  appId?: string;
  tier: CommandRequest["tier"];
}): Promise<{ commandIds: string[] }> {
  // Blast-radius rule: anything touching more than N assets auto-promotes
  // to T5 and must go through the dual-approval path, never silently.
  const effectiveTier =
    args.assetIds.length > MAX_BLAST_RADIUS_BEFORE_T5_PROMOTION && args.tier !== "T5" && args.tier !== "T6"
      ? "T5"
      : args.tier;

  const commandIds: string[] = [];

  for (const assetId of args.assetIds) {
    const { data: asset, error: assetError } = await db.from("assets").select("site_id").eq("id", assetId).single();
    if (assetError) throw assetError;

    const decision = await evaluateCommandPolicy({
      operatorId: args.operatorId,
      siteId: asset.site_id,
      tier: effectiveTier,
    });
    if (!decision.allowed) {
      throw new CommandDeniedError(decision.deniedReason ?? "policy denied");
    }

    const commandId = randomUUID();
    const request = CommandRequest.parse({
      commandId,
      assetId,
      ticketRef: args.ticketRef,
      operatorId: args.operatorId,
      tier: effectiveTier,
      kind: args.kind,
      scriptId: args.scriptId,
      scriptVersion: args.scriptVersion,
      scriptSha256: args.scriptSha256,
      args: args.cmdArgs ?? {},
      adhocCommand: args.adhocCommand,
      serviceName: args.serviceName,
      serviceAction: args.serviceAction,
      appId: args.appId,
    });

    const { error: enqueueError } = await db.rpc("enqueue_command", { p_message: request });
    if (enqueueError) throw enqueueError;

    const { error: runError } = await db.from("command_runs").insert({
      command_id: commandId,
      asset_id: assetId,
      operator_id: args.operatorId,
      ticket_ref: args.ticketRef ?? null,
      tier: effectiveTier,
      kind: args.kind,
      script_id: args.scriptId ?? null,
      script_sha256: args.scriptSha256 ?? null,
      command_text: args.adhocCommand ?? null,
    });
    if (runError) throw runError;

    await db.from("audit_log").insert({
      actor_id: args.operatorId,
      actor_kind: "operator",
      action: "command.dispatched",
      target_type: "asset",
      target_id: assetId,
      tier: effectiveTier,
      decision: "allowed",
      detail: { command_id: commandId, kind: args.kind, script_id: args.scriptId ?? null },
    });

    commandIds.push(commandId);
  }

  return { commandIds };
}

/**
 * Called by the agent's poll loop to fetch ITS OWN queued work.
 *
 * assetId is mandatory, not optional-with-a-default: the queue is shared
 * across the whole fleet and pgmq's `conditional` filter (migration 0025) is
 * the only thing stopping one machine from dequeuing another's commands.
 * An unfiltered read here would silently execute a Lagos command on Dubai.
 */
export async function pollCommands(assetId: string, maxMessages = 5) {
  const { data, error } = await db.rpc("dequeue_commands", {
    p_asset_id: assetId,
    p_visibility_timeout_seconds: 60,
    p_max_messages: maxMessages,
  });
  if (error) throw error;
  return data ?? [];
}

/** Called by the agent after executing a command — records the transcript and acks the queue. */
export async function reportCommandResult(msgId: number, result: CommandResult) {
  const parsed = CommandResult.parse(result);

  const { error: updateError } = await db
    .from("command_runs")
    .update({
      started_at: parsed.startedAt,
      finished_at: parsed.finishedAt,
      duration_ms: parsed.durationMs,
      exit_code: parsed.exitCode,
      stdout: parsed.stdout,
      stderr: parsed.stderr,
      outcome: parsed.outcome,
      refusal_reason: parsed.refusalReason ?? null,
      verification: parsed.verification ?? null,
    })
    .eq("command_id", parsed.commandId);
  if (updateError) throw updateError;

  await db.from("audit_log").insert({
    actor_kind: "agent",
    action: "command.result",
    target_type: "command",
    target_id: parsed.commandId,
    decision: parsed.outcome === "success" ? "allowed" : "denied",
    detail: { outcome: parsed.outcome, exit_code: parsed.exitCode, duration_ms: parsed.durationMs },
  });

  const { error: ackError } = await db.rpc("ack_command", { p_msg_id: msgId });
  if (ackError) throw ackError;
}
