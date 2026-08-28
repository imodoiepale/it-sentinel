import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Request-scoped carrier for the elevation token a caller presented.
 *
 * Why ambient context rather than another parameter threaded through
 * dispatchCommand: dispatchCommand is the single funnel every actor uses —
 * console, voice webhooks, playbooks — and the ones that exist today plus
 * every one added later must be UNABLE to reach T4 by accident. With the
 * token passed explicitly, a new caller that simply forgets the argument
 * would be a caller with no elevation and a plausible-looking call site. With
 * it read from context, the same caller runs outside any elevation scope and
 * evaluateCommandPolicy denies T4 for it, silently and correctly. Forgetting
 * to opt in fails closed; there is no way to forget to opt out.
 *
 * The scope is entered only by the HTTP route that actually received a token
 * from the operator, and it ends when that request's handler does.
 */
const elevationStorage = new AsyncLocalStorage<string>();

export function runWithElevationToken<T>(token: string | undefined, fn: () => T): T {
  return token ? elevationStorage.run(token, fn) : fn();
}

export function currentElevationToken(): string | undefined {
  return elevationStorage.getStore();
}
