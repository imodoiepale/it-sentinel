-- command_runs.kind learns about app_close, in the SAME change that added it
-- to the Zod enum.
--
-- 0029 is the cautionary tale: CommandKind gained 'app_launch' in
-- packages/contracts/src/command.ts and this constraint was left behind, so
-- dispatchCommand() -- which enqueues onto pgmq FIRST and writes the audit
-- row second -- put the command on the queue, the agent ran it, and only then
-- did the insert fail. Notepad opened on the target machine, the console
-- reported a 500, and the whole action left no row in command_runs for
-- reportCommandResult() to update. An action that happens without being
-- recorded is precisely what this table exists to prevent.
--
-- app_close is the counterpart to app_launch: it resolves an app identifier
-- against a fixed allowlist on the agent (apps/agent-node/src/exec/
-- process-control.ts) and closes that process gracefully, forcing it only if
-- it will not go. It is dispatched at T3 or above, because terminating a
-- process changes machine state and can discard unsaved work.

alter table public.command_runs drop constraint if exists command_runs_kind_check;

alter table public.command_runs
  add constraint command_runs_kind_check
  check (kind in ('signed_script', 'adhoc_powershell', 'service_action', 'app_launch', 'app_close'));

comment on column public.command_runs.kind is
  'Mirrors CommandKind in packages/contracts/src/command.ts. Adding a value there requires a migration here; the two cannot validate each other.';
