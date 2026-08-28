import { describe, expect, it } from "vitest";
import {
  CONTROLLABLE_SERVICES,
  CONTROLLABLE_SERVICE_IDS,
  LAUNCHABLE_APPS,
  LAUNCHABLE_APP_IDS,
} from "@it-sentinel/contracts";
import { ALLOWED_APPS, resolveApp } from "../src/exec/app-launcher.js";
import { ALLOWED_SERVICES, resolveService } from "../src/exec/service-actions.js";

/**
 * The launchable-app and controllable-service allowlists are split across two
 * packages on purpose: the ids and spoken labels are contract (the control
 * plane enumerates them for the voice agent's describe_capabilities), the
 * commands and Windows service names stay in this agent. That split has one
 * failure mode, and it is a quiet one — an id that exists on one side and not
 * the other. The voice agent then offers to open an app that the executor
 * refuses, or silently stops offering one that works, and neither shows up
 * until someone asks for it out loud in front of an audience.
 *
 * The Record<LaunchableAppId, string> / Record<ControllableServiceId, string>
 * typing on the agent's tables already makes that a compile error. This test
 * is the runtime backstop for the case where someone reaches for a widening
 * `Record<string, string>` to make the build go green.
 */

describe("the app vocabulary and the agent's command table cannot drift", () => {
  it("every contract app id has a launch command here", () => {
    for (const id of LAUNCHABLE_APP_IDS) {
      expect(ALLOWED_APPS[id], `contract app id "${id}" has no entry in ALLOWED_APPS`).toBeDefined();
      expect(ALLOWED_APPS[id]!.command.length).toBeGreaterThan(0);
    }
  });

  it("the agent launches nothing the contract does not name", () => {
    expect(Object.keys(ALLOWED_APPS).sort()).toEqual([...LAUNCHABLE_APP_IDS].sort());
  });

  it("labels come from the contract, so both sides say the same words", () => {
    for (const id of LAUNCHABLE_APP_IDS) {
      expect(resolveApp(id).label).toBe(LAUNCHABLE_APPS[id]);
    }
  });
});

describe("the service vocabulary and the agent's service-name table cannot drift", () => {
  it("every contract service id maps to a real Windows service name here", () => {
    for (const id of CONTROLLABLE_SERVICE_IDS) {
      expect(ALLOWED_SERVICES[id], `contract service id "${id}" has no entry in ALLOWED_SERVICES`).toBeDefined();
      // Same shape the adversarial suite pins: a bare service name, nothing
      // a shell could read as anything else.
      expect(ALLOWED_SERVICES[id]!.serviceName).toMatch(/^[A-Za-z0-9_]+$/);
    }
  });

  it("the agent controls nothing the contract does not name", () => {
    expect(Object.keys(ALLOWED_SERVICES).sort()).toEqual([...CONTROLLABLE_SERVICE_IDS].sort());
  });

  it("labels come from the contract, so both sides say the same words", () => {
    for (const id of CONTROLLABLE_SERVICE_IDS) {
      expect(resolveService(id).label).toBe(CONTROLLABLE_SERVICES[id]);
    }
  });

  it("still names WinDefend, so stopping it is refused by T6 rather than as an unknown service", () => {
    // Moving Defender out of the vocabulary would relocate the refusal from
    // the deny list to an allowlist lookup, which is the regression
    // service-actions.ts warns about at length. Guarded here too, because the
    // vocabulary now lives in a different package to that comment.
    expect(CONTROLLABLE_SERVICE_IDS).toContain("defender");
    expect(resolveService("defender").serviceName).toBe("WinDefend");
  });
});
