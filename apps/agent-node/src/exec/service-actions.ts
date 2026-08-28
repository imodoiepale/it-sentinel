import {
  CONTROLLABLE_SERVICES,
  CONTROLLABLE_SERVICE_IDS,
  type CommandRequest,
  type ControllableServiceId,
} from "@it-sentinel/contracts";

/**
 * Service-name allowlist for the `service_action` command kind.
 *
 * Same reasoning as app-launcher.ts, and the same refusal to bend it: the
 * service name reaching this agent may have started life as speech ("restart
 * the print spooler"), so interpolating it into a command string would hand
 * whatever a speech-to-text engine produced straight to PowerShell. The
 * request carries an *identifier*, this table maps it to a real Windows
 * service name, and anything not in the table is refused. `Get-Service`-style
 * wildcards are deliberately absent — `Enquest*` would resolve to a set the
 * reviewer of this file cannot see.
 *
 * Adding an entry here is a deliberate, reviewable act. That is the point.
 *
 * ── WinDefend is in this table ON PURPOSE, read this before "fixing" it
 * Stopping Windows Defender is a T6 deny-list offence (`disable_antivirus` in
 * deny-list.ts). It is NOT excluded here, because excluding it would move the
 * refusal from the one mechanism that cannot be reached around — the T6 check
 * the executor runs on every command text, unconditionally, before anything
 * executes — into an allowlist that a future edit could widen without anyone
 * noticing the security consequence. The executor resolves the command text
 * from this table BEFORE the deny-list check for exactly that reason, so
 * "stop defender" is refused by T6 and shows up in the audit trail as a deny
 * pattern hit rather than as an unknown-service typo. Starting Defender, and
 * checking on it, stay possible.
 */

export interface ManageableService {
  /** Real Windows service name. Fixed text — never interpolated with input. */
  readonly serviceName: string;
  /** What to call it when reporting back. */
  readonly label: string;
}

/**
 * The half of the table that must stay here: id -> real Windows service name.
 *
 * The ids and spoken labels live in @it-sentinel/contracts so the control
 * plane can enumerate them for the voice agent's describe_capabilities
 * without a second hand-maintained copy going stale. The Windows service
 * names deliberately do not travel with them: they are the text that ends up
 * in a command, and nothing outside this agent gets a say in it.
 *
 * Typing this as Record<ControllableServiceId, string> means a new id in the
 * contract with no service name here fails the build, instead of the voice
 * agent offering a service that refuses on arrival.
 */
const SERVICE_NAMES: Record<ControllableServiceId, string> = {
  spooler: "Spooler",
  printer: "Spooler",
  "print spooler": "Spooler",
  dns: "Dnscache",
  dhcp: "Dhcp",
  time: "W32Time",
  defender: "WinDefend",
  workstation: "LanmanWorkstation",
  netlogon: "Netlogon",
  update: "wuauserv",
  "windows update": "wuauserv",
  // The repo only ever pins Enquest by process name and by the `Enquest*`
  // prefix (packages/scripts/library/enquest-check-services.ps1). The prefix
  // is a diagnostic convenience there; here it would be an unbounded target,
  // so this entry names the one service the demo actually restarts.
  enquest: "Enquest",
};

export const ALLOWED_SERVICES: Record<string, ManageableService> = Object.fromEntries(
  CONTROLLABLE_SERVICE_IDS.map((id) => [
    id,
    { serviceName: SERVICE_NAMES[id], label: CONTROLLABLE_SERVICES[id] },
  ]),
);

/**
 * The three actions the contract permits. Derived from CommandRequest rather
 * than redeclared, so a change to the contract's ServiceAction enum breaks
 * the ACTION_CMDLET map below at compile time instead of silently leaving a
 * new action unmapped (an unmapped action would build the text "undefined
 * -Name Spooler", which is precisely the class of silent no-op this kind was
 * added to stop doing).
 */
export type ServiceActionKind = NonNullable<CommandRequest["serviceAction"]>;

/** start/stop/restart → the cmdlet that performs it. All three are in the T3 allowlist. */
const ACTION_CMDLET: Record<ServiceActionKind, string> = {
  start: "Start-Service",
  stop: "Stop-Service",
  restart: "Restart-Service",
};

export class UnknownServiceError extends Error {
  constructor(public readonly requested: string) {
    super(
      `"${requested}" is not in the manageable-service allowlist. Permitted: ${listServiceIds().join(", ")}`,
    );
  }
}

/** The identifiers this table accepts, for error messages and operator hints. */
export function listServiceIds(): string[] {
  return Object.keys(ALLOWED_SERVICES);
}

/**
 * Resolves a friendly service identifier to its real Windows service name.
 * Case- and whitespace-insensitive because the id often originates from
 * speech, but the match is exact against the table — no fuzzy matching, no
 * prefix wildcards, and no fallback to "just try the name we were given".
 */
export function resolveService(serviceId: string): ManageableService {
  const key = serviceId.trim().toLowerCase();
  const service = ALLOWED_SERVICES[key];
  if (!service) throw new UnknownServiceError(serviceId);
  return service;
}

/**
 * Builds the command text for a service action. Both halves come from fixed
 * tables, so the result contains no caller-supplied characters at all — the
 * only thing the caller chose is *which* pair of table entries to combine.
 */
export function serviceCommandFor(action: ServiceActionKind, service: ManageableService): string {
  return `${ACTION_CMDLET[action]} -Name ${service.serviceName}`;
}
