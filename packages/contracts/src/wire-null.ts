/**
 * Drops null-valued keys from a decoded JSON payload before it is validated.
 *
 * JSON has no `undefined`. A producer saying "I have no value for this"
 * writes `null` — and PowerShell's ConvertTo-Json ALWAYS writes null for
 * $null, with no way to omit the key. Zod's `.optional()` accepts a missing
 * key but rejects an explicit null, so every one of the contract's 38
 * optional fields was a payload that could never validate from a PowerShell
 * collector. In practice a real machine failed on four of them at once
 * (networkLatencyMs, internetLatencyMs and two printer errorStates) and
 * simply never appeared on the board.
 *
 * The alternative was widening all 38 to `.nullish()`, which would push
 * `| null` into every consumer of the parsed type for no gain: nothing in
 * this contract distinguishes "explicitly null" from "absent". So the schema
 * stays strict about what it means, and the boundary is lenient about how it
 * arrives — applied in exactly one place, so a collector written in any
 * language gets the same treatment.
 *
 * Deliberately NOT touched:
 *  - nulls inside arrays. Removing an element would shift indices and change
 *    a list's length, which is a different claim about the world than
 *    "this field is unknown".
 *  - anything under a key the contract types as a free-form record, since a
 *    null there may be real data rather than an absent field.
 */
export function stripWireNulls<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((v) => stripWireNulls(v)) as unknown as T;
  }
  if (value === null || typeof value !== "object") return value;

  const out: Record<string, unknown> = {};
  for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === null) continue;
    out[key] = stripWireNulls(v);
  }
  return out as unknown as T;
}
