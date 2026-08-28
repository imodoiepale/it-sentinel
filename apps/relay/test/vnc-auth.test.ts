import { describe, expect, it } from "vitest";
import { deriveVncDesKey, encryptVncChallenge } from "../src/vnc-auth.js";

/**
 * Self-consistency tests only — deliberately not validated against a known
 * ciphertext vector copied from an existing VNC implementation, per the
 * plan's clean-room provenance rule for this file (RFC 6143 and our own
 * packet captures against a live TightVNC Server are the permitted
 * references, not another project's test suite). Real interop is verified
 * against an actual TightVNC Server, not spec-derived unit tests.
 */

describe("deriveVncDesKey", () => {
  it("produces exactly 8 bytes regardless of password length", () => {
    expect(deriveVncDesKey("short").length).toBe(8);
    expect(deriveVncDesKey("exactly8").length).toBe(8);
    expect(deriveVncDesKey("this password is way longer than eight bytes").length).toBe(8);
    expect(deriveVncDesKey("").length).toBe(8);
  });

  it("zero-pads a short password rather than leaving garbage bytes", () => {
    const key = deriveVncDesKey("ab");
    // Byte-reversal of 0x00 is still 0x00 — padding bytes stay zero after reversal.
    expect(key[2]).toBe(0);
    expect(key[7]).toBe(0);
  });

  it("bit-reverses each key byte per the RFC 6143 quirk (0x01 -> 0x80)", () => {
    const key = deriveVncDesKey("\x01");
    expect(key[0]).toBe(0x80);
  });

  it("is deterministic for the same password", () => {
    expect(deriveVncDesKey("branch-vnc-pass").equals(deriveVncDesKey("branch-vnc-pass"))).toBe(true);
  });

  it("produces different keys for different passwords", () => {
    expect(deriveVncDesKey("alpha123").equals(deriveVncDesKey("zulu9876"))).toBe(false);
  });
});

describe("encryptVncChallenge", () => {
  const challenge = Buffer.from("0123456789ABCDEF", "utf-8"); // 16 bytes

  it("rejects a challenge that isn't exactly 16 bytes", () => {
    expect(() => encryptVncChallenge("pw", Buffer.alloc(15))).toThrow(/16 bytes/);
    expect(() => encryptVncChallenge("pw", Buffer.alloc(17))).toThrow(/16 bytes/);
  });

  it("produces a 16-byte response for a 16-byte challenge", () => {
    const response = encryptVncChallenge("branch-vnc-pass", challenge);
    expect(response.length).toBe(16);
  });

  it("is deterministic for the same password and challenge", () => {
    const r1 = encryptVncChallenge("branch-vnc-pass", challenge);
    const r2 = encryptVncChallenge("branch-vnc-pass", challenge);
    expect(r1.equals(r2)).toBe(true);
  });

  it("produces a different response for a different password", () => {
    const r1 = encryptVncChallenge("alpha123", challenge);
    const r2 = encryptVncChallenge("zulu9876", challenge);
    expect(r1.equals(r2)).toBe(false);
  });

  it("produces a different response for a different challenge", () => {
    const otherChallenge = Buffer.from("FEDCBA9876543210", "utf-8");
    const r1 = encryptVncChallenge("branch-vnc-pass", challenge);
    const r2 = encryptVncChallenge("branch-vnc-pass", otherChallenge);
    expect(r1.equals(r2)).toBe(false);
  });

  it("encrypts the two 8-byte halves independently, not as one 16-byte block", () => {
    // If the two halves were encrypted independently (as the RFC requires),
    // changing only the second half of the challenge must leave the first
    // 8 bytes of the response unchanged.
    const challengeA = Buffer.concat([challenge.subarray(0, 8), Buffer.alloc(8, 0)]);
    const challengeB = Buffer.concat([challenge.subarray(0, 8), Buffer.alloc(8, 0xff)]);
    const rA = encryptVncChallenge("branch-vnc-pass", challengeA);
    const rB = encryptVncChallenge("branch-vnc-pass", challengeB);
    expect(rA.subarray(0, 8).equals(rB.subarray(0, 8))).toBe(true);
    expect(rA.subarray(8, 16).equals(rB.subarray(8, 16))).toBe(false);
  });
});
