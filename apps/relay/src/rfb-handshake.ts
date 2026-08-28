import { Socket } from "node:net";
import { BufferedReader } from "./buffered-reader.js";
import { encryptVncChallenge } from "./vnc-auth.js";

/**
 * RFB 3.8 handshake, implemented directly from RFC 6143 §7.1-7.3. This is
 * the ONLY part of the protocol the relay speaks itself — everything after
 * a successful SecurityResult (ClientInit, ServerInit, framebuffer
 * updates, all encodings) is piped transparently between the browser's
 * WebSocket and this TCP socket, and noVNC on the client side is what
 * actually implements those. The relay never becomes a full VNC client —
 * it only needs to get past authentication on the operator's behalf so
 * the browser never holds the password.
 *
 * Provenance: RFC 6143 and our own packet captures against a running
 * TightVNC Server are the only references used to write this file.
 */

const SECURITY_TYPE_NONE = 1;
const SECURITY_TYPE_VNC_AUTH = 2;
const AUTH_OK = 0;

export class RfbHandshakeError extends Error {}

export interface HandshakeResult {
  /** Any bytes the server already sent past the handshake boundary (rare, but possible if it pipelines ServerInit immediately) — must be replayed to the client before piping raw socket data further. */
  leftover: Buffer;
}

/**
 * Performs the version exchange, security negotiation, and VNC-auth
 * challenge/response against an already-connected TCP socket to a TightVNC
 * (or any RFB 3.8-compatible) server. Throws RfbHandshakeError on any
 * protocol violation or auth failure — the caller (session redemption
 * path) must close the socket and refuse the session on any throw here,
 * never fall back to passing the raw socket through unauthenticated.
 */
export async function performVncAuthHandshake(socket: Socket, password: string): Promise<HandshakeResult> {
  const reader = new BufferedReader(socket);

  // 1. ProtocolVersion handshake (RFC 6143 §7.1.1) — exactly 12 bytes,
  // "RFB 003.008\n". We request 3.8 unconditionally; a server offering an
  // older version still replies with its own line, which we just mirror
  // back as our own version claim is what the server actually enforces.
  const serverVersion = await reader.readExact(12);
  if (!serverVersion.toString("ascii").startsWith("RFB 003.")) {
    throw new RfbHandshakeError(`unexpected protocol version line: ${serverVersion.toString("ascii").trim()}`);
  }
  socket.write(Buffer.from("RFB 003.008\n", "ascii"));

  // 2. Security handshake (RFC 6143 §7.1.2) — RFB 3.8: server sends a
  // count then that many 1-byte security-type IDs.
  const countBuf = await reader.readExact(1);
  const typeCount = countBuf[0];
  if (typeCount === 0) {
    // Server refused outright; a 4-byte reason-length + UTF-8 reason follows.
    const reasonLenBuf = await reader.readExact(4);
    const reasonLen = reasonLenBuf.readUInt32BE(0);
    const reason = await reader.readExact(reasonLen);
    throw new RfbHandshakeError(`server refused connection: ${reason.toString("utf-8")}`);
  }
  const types = await reader.readExact(typeCount);
  const availableTypes = new Set(types);

  if (availableTypes.has(SECURITY_TYPE_VNC_AUTH)) {
    socket.write(Buffer.from([SECURITY_TYPE_VNC_AUTH]));
    const challenge = await reader.readExact(16);
    const response = encryptVncChallenge(password, challenge);
    socket.write(response);
  } else if (availableTypes.has(SECURITY_TYPE_NONE)) {
    socket.write(Buffer.from([SECURITY_TYPE_NONE]));
  } else {
    throw new RfbHandshakeError(`server does not offer VNC Authentication or None (offered: ${[...availableTypes].join(",")})`);
  }

  // 3. SecurityResult (RFC 6143 §7.1.3) — 4-byte big-endian, 0 = OK.
  const resultBuf = await reader.readExact(4);
  const result = resultBuf.readUInt32BE(0);
  if (result !== AUTH_OK) {
    const reasonLenBuf = await reader.readExact(4).catch(() => Buffer.alloc(4));
    const reasonLen = reasonLenBuf.readUInt32BE(0);
    const reason = reasonLen > 0 ? (await reader.readExact(reasonLen)).toString("utf-8") : "authentication failed";
    throw new RfbHandshakeError(`VNC authentication rejected: ${reason}`);
  }

  return { leftover: reader.takeRemainder() };
}
