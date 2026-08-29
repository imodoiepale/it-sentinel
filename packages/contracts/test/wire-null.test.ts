import { describe, expect, it } from "vitest";
import { z } from "zod";
import { stripWireNulls } from "../src/wire-null.js";

/**
 * Regression guard for a heartbeat that could never validate.
 *
 * JSON has no `undefined`, and PowerShell's ConvertTo-Json always writes
 * `null` for an absent value with no way to omit the key. Zod's `.optional()`
 * accepts a missing key but rejects an explicit null, so every optional field
 * in HeartbeatPayload was unreachable from a PowerShell collector — a real
 * machine failed on four at once and simply never appeared in the fleet.
 */

describe("stripWireNulls", () => {
  it("removes null-valued keys so .optional() accepts the payload", () => {
    const schema = z.object({ a: z.number(), b: z.number().optional() });
    // Exactly the shape ConvertTo-Json produces for an absent value.
    expect(schema.safeParse({ a: 1, b: null }).success).toBe(false);
    expect(schema.safeParse(stripWireNulls({ a: 1, b: null })).success).toBe(true);
  });

  it("recurses into nested objects", () => {
    expect(stripWireNulls({ net: { latency: null, up: true } })).toEqual({ net: { up: true } });
  });

  it("recurses into objects inside arrays", () => {
    // The printers[].errorState case: nulls were nested one array deep.
    expect(stripWireNulls({ printers: [{ name: "HP", errorState: null }] })).toEqual({
      printers: [{ name: "HP" }],
    });
  });

  it("does NOT remove null ELEMENTS from an array", () => {
    // Dropping an element shifts indices and changes a list's length, which
    // is a different claim than "this field is unknown".
    expect(stripWireNulls({ xs: [1, null, 3] })).toEqual({ xs: [1, null, 3] });
  });

  it("leaves falsy-but-present values alone", () => {
    // 0, "" and false are data. Only null means absent.
    expect(stripWireNulls({ a: 0, b: "", c: false })).toEqual({ a: 0, b: "", c: false });
  });

  it("preserves arrays as arrays", () => {
    const out = stripWireNulls({ volumes: [{ drive: "C:", smart: null }] }) as { volumes: unknown[] };
    expect(Array.isArray(out.volumes)).toBe(true);
  });

  it("handles a null at the top level and primitives", () => {
    expect(stripWireNulls(null)).toBeNull();
    expect(stripWireNulls(42)).toBe(42);
    expect(stripWireNulls("x")).toBe("x");
  });

  it("keeps a nested object that becomes empty, rather than deleting it", () => {
    // The key existing with no fields is still a truthful statement that the
    // collector reported the section; removing it would look like it did not.
    expect(stripWireNulls({ detail: { a: null } })).toEqual({ detail: {} });
  });
});
