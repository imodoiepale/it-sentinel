import { LAUNCHABLE_APPS, LAUNCHABLE_APP_IDS, type LaunchableAppId } from "@it-sentinel/contracts";

/**
 * Named-application allowlist for the `app_launch` command kind.
 *
 * "Open Chrome on Lagos" is a demo requirement, but the obvious
 * implementation — pass the spoken app name into Start-Process — would hand
 * arbitrary process creation to whatever a speech-to-text engine produced,
 * which is exactly the capability tier-resolver.ts and deny-list.ts exist to
 * withhold. So no operator-supplied string ever reaches the shell: the
 * request carries an *identifier*, this table maps it to a fixed command,
 * and anything not in the table is refused.
 *
 * Adding an entry here is a deliberate, reviewable act. That is the point.
 *
 * ── Windows session-0 isolation, read this before debugging a "silent" launch
 * A process started by a service running as LocalSystem lands in session 0
 * and is INVISIBLE on the interactive desktop — it runs, it appears in Task
 * Manager, and nobody sees a window. For a demo where the whole point is
 * that a window visibly appears, the agent must run in the logged-in user's
 * session (`pnpm --filter @it-sentinel/agent-node start` from a normal
 * terminal), NOT via install-service.ps1. launchIsVisible() below reports
 * which situation this process is in so the result says so out loud rather
 * than reporting a misleading success.
 */

export interface LaunchableApp {
  /** PowerShell command to run. Fixed text — never interpolated with input. */
  readonly command: string;
  /** What to call it when reporting back. */
  readonly label: string;
}

/**
 * The half of the table that must stay here: id -> fixed command text.
 *
 * The ids and spoken labels live in @it-sentinel/contracts, because the
 * control plane has to enumerate them for the voice agent's
 * describe_capabilities and a second hand-maintained copy over there would
 * drift. The command strings deliberately do NOT travel with them — they are
 * execution detail, and keeping them in the agent means nothing off-box has
 * a say in what actually runs.
 *
 * Typing this as Record<LaunchableAppId, string> makes the two halves
 * inseparable at compile time: a new id in the contract with no command here
 * fails the build, rather than surfacing as the agent offering an app that
 * refuses when someone asks for it.
 */
const APP_COMMANDS: Record<LaunchableAppId, string> = {
  notepad: "Start-Process notepad",
  calculator: "Start-Process calc",
  calc: "Start-Process calc",
  explorer: "Start-Process explorer",
  chrome: "Start-Process chrome",
  browser: "Start-Process chrome",
  edge: "Start-Process msedge",
  camera: "Start-Process microsoft.windows.camera:",
  taskmanager: "Start-Process taskmgr",
  "task manager": "Start-Process taskmgr",
  eventviewer: "Start-Process eventvwr",
  services: "Start-Process services.msc",
  control: "Start-Process control",
};

export const ALLOWED_APPS: Record<string, LaunchableApp> = Object.fromEntries(
  LAUNCHABLE_APP_IDS.map((id) => [id, { command: APP_COMMANDS[id], label: LAUNCHABLE_APPS[id] }]),
);

export class UnknownAppError extends Error {
  constructor(public readonly requested: string) {
    super(
      `"${requested}" is not in the launchable-app allowlist. Permitted: ${Object.keys(ALLOWED_APPS).join(", ")}`,
    );
  }
}

/**
 * Resolves an app identifier to its fixed launch command. Case- and
 * whitespace-insensitive because the id often originates from speech, but
 * the match is exact against the table — no fuzzy matching, no fallback to
 * "just try running it".
 */
export function resolveApp(appId: string): LaunchableApp {
  const key = appId.trim().toLowerCase();
  const app = ALLOWED_APPS[key];
  if (!app) throw new UnknownAppError(appId);
  return app;
}

/**
 * True when a launched GUI app will actually be visible to the person at
 * the machine. Windows services run in session 0; interactive logons do
 * not. process.env.SESSIONNAME is set for interactive sessions ("Console"
 * or "RDP-Tcp#n") and absent under LocalSystem.
 */
export function launchIsVisible(): boolean {
  return Boolean(process.env.SESSIONNAME);
}
