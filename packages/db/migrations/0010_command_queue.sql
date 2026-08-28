-- pgmq-backed store-and-forward: one queue per agent, so a command survives
-- a WAN drop and is delivered/acked when the branch reconnects, rather than
-- being lost or requiring an inbound connection to the branch.

select pgmq.create('agent_commands');

comment on schema pgmq is 'Command orchestrator dispatch queue. apps/control-plane/src/orchestrator enqueues CommandRequest envelopes (packages/contracts/src/command.ts); agents long-poll pgmq.read scoped to their own asset_id via the control-plane API, never directly.';
