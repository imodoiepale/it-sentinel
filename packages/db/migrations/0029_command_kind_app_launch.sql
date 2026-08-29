-- command_runs.kind never learned about app_launch.
--
-- CommandKind in packages/contracts/src/command.ts gained 'app_launch' when
-- "open Chrome on Lagos" was added, but the CHECK constraint here was left
-- at the original three. The failure mode was genuinely confusing:
-- dispatchCommand() enqueues onto pgmq FIRST and writes the audit row
-- second, so the agent picked the command up and Notepad really did open on
-- the target machine -- and then the insert violated this constraint, the
-- route returned 500, and the console reported an error for a command that
-- had already succeeded.
--
-- Worse than the confusion: the run had no command_runs row, so
-- reportCommandResult() later updated nothing and the whole action left no
-- trace in the audit trail. An action that happens without being recorded is
-- exactly what this table exists to prevent.
--
-- The lesson worth writing down: CommandKind is declared in two places that
-- cannot check each other -- a Zod enum and this constraint -- and only the
-- Zod side is covered by tests. Adding a kind means changing both.

alter table public.command_runs drop constraint if exists command_runs_kind_check;

alter table public.command_runs
  add constraint command_runs_kind_check
  check (kind in ('signed_script', 'adhoc_powershell', 'service_action', 'app_launch'));

comment on column public.command_runs.kind is
  'Mirrors CommandKind in packages/contracts/src/command.ts. Adding a value there requires a migration here; the two cannot validate each other.';
