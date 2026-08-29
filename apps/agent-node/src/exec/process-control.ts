import { LAUNCHABLE_APPS, LAUNCHABLE_APP_IDS, type LaunchableAppId } from "@it-sentinel/contracts";

/**
 * Named-process allowlist for the `app_close` command kind — the counterpart
 * to app-launcher.ts, and built on exactly the same refusal.
 *
 * An operator could open Notepad and the Camera app on a laptop across the
 * room and then had no way to get rid of them, which made every launch a
 * one-way door. The obvious fix — pass the spoken app name into Stop-Process
 * — is worse than the one it replaces: `Stop-Process -Name <whatever speech
 * produced>` is an arbitrary-process-termination primitive, and unlike a
 * stray Start-Process a stray Stop-Process can take the machine off the
 * network, off the remote-desktop server, or off the air entirely. So the
 * request carries an *identifier*, this table maps it to a fixed process
 * name, and anything not in the table is refused.
 *
 * ── The list is derived from the launcher's vocabulary on purpose
 * If you can open it you should be able to close it, so the table below is
 * typed as Record<LaunchableAppId, ...> and the compiler will not let a new
 * launchable app be added without someone deciding, in writing, whether it
 * can be closed again. Several deliberately cannot (value `null`, with the
 * reason attached); see NOT_CLOSABLE below.
 *
 * ── Nothing here is a general "kill by name" facility
 * PROTECTED_PROCESSES is checked before and after the table lookup, so even
 * an edit that put lsass in the table would be refused at runtime. That
 * belt-and-braces is the point: the table is the thing a future change is
 * most likely to widen carelessly.
 */

export interface ClosableProcess {
  /** Real Windows process name (no .exe). Fixed text — never interpolated with input. */
  readonly processName: string;
  /** What to call it when reporting back. */
  readonly label: string;
}

/**
 * Processes that must never be terminated by this agent, whatever anyone
 * asks and whatever the table above says, each with the reason it is here.
 *
 * The three groups, in descending order of how badly they end:
 *   - lsass/csrss/wininit/winlogon/services/smss: Windows does not survive
 *     losing these. Terminating lsass.exe bluescreens the machine outright.
 *   - node/pwsh/powershell: the agent itself and the shell it runs every
 *     command through. Killing one of these makes the machine unmanageable
 *     and unrecoverable remotely — the very command that would undo it can
 *     no longer be delivered. That is the worst possible outcome of a
 *     "close that" and the reason this list exists at all.
 *   - tvnserver: the remote-desktop server. Killing it severs the only way
 *     back onto the machine's screen, which is exactly what someone reaching
 *     for a remote "close that" needs to keep.
 *
 * Keyed by lowercase process name, matched against both the identifier the
 * caller supplied and the name the table resolved to.
 */
const PROTECTED_PROCESSES: Record<string, string> = {
  node: "node hosts the IT Sentinel agent itself — killing it would leave this machine unable to receive any further command, including the one that would undo it",
  pwsh: "pwsh is the shell this agent executes every command through — killing it kills the command doing the killing and leaves the machine unmanageable",
  powershell:
    "powershell is the shell this agent executes commands through — killing it leaves the machine unable to be managed remotely",
  tvnserver:
    "tvnserver is the remote-desktop server — killing it severs the only remaining way onto this machine's screen",
  lsass: "terminating lsass.exe bluescreens Windows immediately",
  csrss: "csrss.exe is a Windows-critical process; terminating it bluescreens the machine",
  wininit: "wininit.exe is a Windows-critical process; terminating it bluescreens the machine",
  winlogon: "winlogon.exe is a Windows-critical process; terminating it logs the user out or bluescreens the machine",
  services:
    "services.exe is the Windows Service Control Manager; terminating it bluescreens the machine (note that the Services *console* is hosted by mmc.exe and is not closable by name either — see NOT_CLOSABLE)",
  smss: "smss.exe is the Windows Session Manager; terminating it bluescreens the machine",
};

/**
 * Launchable apps that deliberately have no close identifier, and why. These
 * are not oversights — each one is a case where "close X" cannot mean what
 * the operator would expect it to mean.
 */
const NOT_CLOSABLE: Partial<Record<LaunchableAppId, string>> = {
  explorer:
    "explorer.exe is the Windows shell, not just a folder window — terminating it takes the taskbar and the desktop away from whoever is sitting at the machine, and there is no separate process for one folder window",
  eventviewer:
    "Event Viewer runs inside mmc.exe, which also hosts the Services console — closing it by name would close management consoles nobody asked about",
  services:
    "the Services console runs inside mmc.exe, which also hosts Event Viewer, and its name collides with services.exe, the Windows Service Control Manager",
  control:
    "control.exe exits the moment Control Panel opens; the window that remains is hosted by the shell, so there is no Control Panel process to close",
};

/**
 * id -> real Windows process name, or null for "deliberately not closable".
 *
 * Same split as app-launcher.ts and for the same reason: the ids and spoken
 * labels are contract (the control plane enumerates them for the voice
 * agent), and the executable detail — here, the process name that ends up in
 * a Stop-Process — stays in the agent, where nothing off-box has a say in it.
 *
 * Typing this as Record<LaunchableAppId, string | null> is what forces the
 * decision: adding a launchable app in the contract without saying here
 * whether it can be closed fails the build, rather than shipping an app the
 * operator can open and then cannot get rid of. That asymmetry is the bug
 * this whole module exists to fix, so it must not be reintroducible by
 * omission.
 */
const PROCESS_NAMES: Record<LaunchableAppId, string | null> = {
  notepad: "notepad",
  calculator: "CalculatorApp",
  calc: "CalculatorApp",
  explorer: null,
  chrome: "chrome",
  browser: "chrome",
  edge: "msedge",
  camera: "WindowsCamera",
  taskmanager: "Taskmgr",
  "task manager": "Taskmgr",
  eventviewer: null,
  services: null,
  control: null,
};

export const CLOSABLE_PROCESSES: Record<string, ClosableProcess> = Object.fromEntries(
  LAUNCHABLE_APP_IDS.filter((id) => PROCESS_NAMES[id] !== null).map((id) => [
    id,
    { processName: PROCESS_NAMES[id]!, label: LAUNCHABLE_APPS[id] },
  ]),
);

export class UnknownProcessError extends Error {
  constructor(public readonly requested: string) {
    super(
      `"${requested}" is not in the closable-process allowlist. Permitted: ${listClosableIds().join(", ")}`,
    );
  }
}

/** Refusal for a launchable app that deliberately has no close counterpart. */
export class NotClosableError extends Error {
  constructor(
    public readonly requested: string,
    reason: string,
  ) {
    super(`"${requested}" cannot be closed remotely: ${reason}`);
  }
}

/** Refusal for anything on PROTECTED_PROCESSES. Never a typo — always a decision. */
export class ProtectedProcessError extends Error {
  constructor(
    public readonly requested: string,
    reason: string,
  ) {
    super(`refusing to terminate "${requested}": ${reason}`);
  }
}

/** The identifiers this table accepts, for error messages and operator hints. */
export function listClosableIds(): string[] {
  return Object.keys(CLOSABLE_PROCESSES);
}

/**
 * Resolves a friendly app identifier to the fixed process name to close.
 * Case- and whitespace-insensitive because the id often originates from
 * speech, but the match is exact against the table — no fuzzy matching, no
 * wildcards, and no fallback to "just try killing what we were given".
 *
 * The protected check runs on the *identifier* first so that "close lsass"
 * is answered with the actual reason rather than an unknown-identifier
 * shrug — an operator who asks that deserves to be told why not — and again
 * on the *resolved name* afterwards, so that widening PROCESS_NAMES to a
 * protected process still refuses at runtime.
 */
export function resolveClosableProcess(appId: string): ClosableProcess {
  const key = appId.trim().toLowerCase();

  const protectedReason = PROTECTED_PROCESSES[key];
  if (protectedReason) throw new ProtectedProcessError(appId, protectedReason);

  const notClosable = NOT_CLOSABLE[key as LaunchableAppId];
  if (notClosable) throw new NotClosableError(appId, notClosable);

  const target = CLOSABLE_PROCESSES[key];
  if (!target) throw new UnknownProcessError(appId);

  const protectedName = PROTECTED_PROCESSES[target.processName.toLowerCase()];
  if (protectedName) throw new ProtectedProcessError(target.processName, protectedName);

  return target;
}

/**
 * How long the app gets to shut itself down before it is forced. Long enough
 * for a save prompt to appear, short enough to stay inside the default
 * 60-second command timeout.
 */
const GRACE_PERIOD_SECONDS = 3;

/**
 * Builds the close command. The only caller-influenced thing in the result
 * is *which* table entry was selected; every character comes from fixed text.
 *
 * Graceful first, forced only if that fails. CloseMainWindow() sends the same
 * WM_CLOSE the window's X button does, so an app with unsaved work gets to
 * put its "save changes?" prompt up and the document survives — Stop-Process
 * -Force would discard somebody's actual work with no warning and no undo.
 * The force pass still exists because the whole point of this command is to
 * get rid of something that will not go away: an app sitting on a modal
 * dialog ignores WM_CLOSE, and leaving the operator exactly where they
 * started would defeat the feature. So: ask, wait, then insist.
 *
 * A process that was not running at all is reported and exits 0. Closing
 * something already closed is the operator getting what they asked for, not
 * a failure worth paging anyone about.
 */
export function closeCommandFor(target: ClosableProcess): string {
  const name = target.processName;
  return [
    `$targets = Get-Process -Name ${name} -ErrorAction SilentlyContinue`,
    `if (-not $targets) { Write-Output 'no ${name} process was running'; exit 0 }`,
    `$targets | ForEach-Object { $null = $_.CloseMainWindow() }`,
    `Start-Sleep -Seconds ${GRACE_PERIOD_SECONDS}`,
    `$stubborn = Get-Process -Name ${name} -ErrorAction SilentlyContinue`,
    `if ($stubborn) { $stubborn | Stop-Process -Force -ErrorAction SilentlyContinue; Write-Output 'force-closed ${name}' } else { Write-Output 'closed ${name} gracefully' }`,
  ].join("; ");
}

export { PROTECTED_PROCESSES, NOT_CLOSABLE };
