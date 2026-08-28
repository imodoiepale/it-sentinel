import { createCipheriv } from "node:crypto";

/**
 * VNC Authentication per RFC 6143 §7.2.2 — implemented directly from the
 * published specification. No TightVNC/TigerVNC/RealVNC source was read,
 * vendored, or adapted for this file; see the plan's clean-room provenance
 * rule for apps/relay.
 *
 * The one non-obvious step: RFC 6143 requires the password's DES key
 * bytes to be used in bit-reversed order compared to normal DES key
 * convention — this is a documented quirk of the original RFB spec, not
 * an implementation choice.
 *
 * Node's OpenSSL 3.x build disables single-DES-ECB by default (legacy
 * algorithm). This uses the standard cryptographic identity that
 * Triple-DES-EDE3 with all three sub-keys equal degenerates to plain
 * single-DES encryption — E(D(E(x,K),K),K) = E(x,K) since decrypt undoes
 * the middle encrypt — verified empirically against Node's des-ede3-ecb
 * before this was relied on. This is a documented equivalence, not a
 * workaround that changes the cryptographic result.
 */

const CHALLENGE_LENGTH = 16;
const DES_BLOCK_LENGTH = 8;

function reverseBits(byte: number): number {
  let result = 0;
  for (let i = 0; i < 8; i++) {
    result = (result << 1) | ((byte >> i) & 1);
  }
  return result;
}

/** Prepares an 8-byte DES key from a VNC password per RFC 6143's bit-reversal quirk. */
export function deriveVncDesKey(password: string): Buffer {
  const raw = Buffer.alloc(DES_BLOCK_LENGTH, 0);
  const passwordBytes = Buffer.from(password, "utf-8");
  passwordBytes.copy(raw, 0, 0, Math.min(passwordBytes.length, DES_BLOCK_LENGTH));

  const key = Buffer.alloc(DES_BLOCK_LENGTH);
  for (let i = 0; i < DES_BLOCK_LENGTH; i++) {
    key[i] = reverseBits(raw[i]);
  }
  return key;
}

function singleDesEcbEncrypt(key8: Buffer, block8: Buffer): Buffer {
  const key24 = Buffer.concat([key8, key8, key8]);
  const cipher = createCipheriv("des-ede3-ecb", key24, null);
  cipher.setAutoPadding(false);
  return Buffer.concat([cipher.update(block8), cipher.final()]);
}

/**
 * Encrypts the server's 16-byte challenge as two independent 8-byte
 * DES-ECB blocks using the password-derived key — the VNC auth response.
 */
export function encryptVncChallenge(password: string, challenge: Buffer): Buffer {
  if (challenge.length !== CHALLENGE_LENGTH) {
    throw new Error(`VNC challenge must be exactly ${CHALLENGE_LENGTH} bytes, got ${challenge.length}`);
  }
  const key = deriveVncDesKey(password);
  const block1 = singleDesEcbEncrypt(key, challenge.subarray(0, DES_BLOCK_LENGTH));
  const block2 = singleDesEcbEncrypt(key, challenge.subarray(DES_BLOCK_LENGTH, CHALLENGE_LENGTH));
  return Buffer.concat([block1, block2]);
}
