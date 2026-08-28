/**
 * The shared *identifier vocabulary* for the two allowlisted command kinds:
 * which apps may be launched, and which services may be controlled.
 *
 * Why this lives in contracts rather than in the agent
 * ----------------------------------------------------
 * The allowlists themselves are enforced in apps/agent-node, which is where
 * they belong — the agent is the last thing standing between a spoken phrase
 * and PowerShell, so it must never trust a caller's claim about what is
 * permitted. But the control plane also needs the *names*: the voice agent's
 * describe_capabilities answer has to enumerate what can actually be done,
 * and a hand-written list there drifts silently the moment someone adds an
 * entry to the agent's table. The agent then confidently offers an app that
 * does not exist, or omits one that does.
 *
 * So the split is: identifiers and human labels are contract (both sides need
 * them), and the id -> command / id -> Windows service-name mappings stay in
 * agent-node (execution detail, and the part with the security consequence).
 * The agent's tables are typed as `Record<LaunchableAppId, string>` and
 * `Record<ControllableServiceId, string>`, so adding an id here without
 * mapping it there is a compile error rather than a runtime refusal.
 *
 * Aliases are intentional. These ids arrive from speech, and people say
 * "browser" and "task manager" at least as often as "chrome" and
 * "taskmanager". Several ids therefore share a label; anything speaking these
 * aloud should de-duplicate by label (see uniqueLabels below).
 *
 * This module is deliberately dependency-free — no zod, nothing from node: —
 * because it is exported from the package barrel and therefore ends up in the
 * browser bundle that apps/web builds.
 */

/** Launchable app id -> the name to use when speaking about it. */
export const LAUNCHABLE_APPS = {
  notepad: "Notepad",
  calculator: "Calculator",
  calc: "Calculator",
  explorer: "File Explorer",
  chrome: "Google Chrome",
  browser: "Google Chrome",
  edge: "Microsoft Edge",
  camera: "the Camera app",
  taskmanager: "Task Manager",
  "task manager": "Task Manager",
  eventviewer: "Event Viewer",
  services: "the Services console",
  control: "Control Panel",
} as const satisfies Record<string, string>;

export type LaunchableAppId = keyof typeof LAUNCHABLE_APPS;

/** Controllable service id -> the name to use when speaking about it. */
export const CONTROLLABLE_SERVICES = {
  spooler: "the Print Spooler",
  printer: "the Print Spooler",
  "print spooler": "the Print Spooler",
  dns: "the DNS Client",
  dhcp: "the DHCP Client",
  time: "the Windows Time service",
  defender: "Microsoft Defender Antivirus",
  workstation: "the Workstation service",
  netlogon: "the Netlogon service",
  update: "Windows Update",
  "windows update": "Windows Update",
  enquest: "the Enquest service",
} as const satisfies Record<string, string>;

export type ControllableServiceId = keyof typeof CONTROLLABLE_SERVICES;

export const LAUNCHABLE_APP_IDS = Object.keys(LAUNCHABLE_APPS) as LaunchableAppId[];

export const CONTROLLABLE_SERVICE_IDS = Object.keys(CONTROLLABLE_SERVICES) as ControllableServiceId[];

/**
 * Labels with the alias duplicates collapsed, in declaration order. Reading
 * "Google Chrome, Google Chrome" out loud is how a capabilities answer stops
 * sounding like it knows what it is talking about.
 */
export function uniqueLabels(table: Record<string, string>): string[] {
  return [...new Set(Object.values(table))];
}
