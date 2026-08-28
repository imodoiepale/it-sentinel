# 08 — Relay and Remote Access

## Why this exists as its own document

This is the piece with the most legally and technically sensitive design decisions in the whole system, and it's also where a real bug was found and fixed during development — worth understanding in detail rather than taking on faith.

## The clean-room rule

**No TightVNC, TigerVNC, RealVNC, or MightyViewer source was read, vendored, transcribed, or adapted anywhere in `apps/relay`.** The only permitted references were RFC 6143 (the published RFB protocol specification) and this project's own packet observations against a running TightVNC Server. `noVNC` (`apps/web/components/viewer/NoVncCanvas.tsx`) is used as an unmodified dependency under its MPL-2.0 license — a rendering client, not a source copied from.

TightVNC Server keeps running **completely unmodified** on every branch PC as the wire-protocol endpoint. Nothing about this system requires touching TightVNC's source, so no GPL question ever arises for our code.

## What the relay actually does

`apps/relay/src/main.ts` is a WebSocket server. A browser connects to `wss://relay/session/<singleUseToken>`. From there:

1. **Redeem the token** — `redeem_session_token()`, an atomic Postgres function that only succeeds once per token, before expiry. Fails closed: an invalid, expired, or already-used token gets the connection closed immediately.
2. **Look up the asset's IP** from `assets`.
3. **Decrypt the credential** — `decrypt_credential_for_session(credentialId, sessionId)`, the one function in the whole database that can return a plaintext secret, grant-restricted to `service_role`. The relay is the only caller anywhere in the system.
4. **Open a TCP socket** to the branch machine's VNC port and **complete the RFB handshake on the operator's behalf** — the browser never sees, requests, or handles the password.
5. **Discard the plaintext** — set to `null` the moment the handshake completes, never logged, never written anywhere.
6. **Become a dumb pipe** — every byte after the handshake flows unmodified between the WebSocket and the TCP socket. noVNC in the browser implements `ClientInit`/`ServerInit`/framebuffer encodings itself; the relay never parses another RFB message after auth succeeds.

## The RFB handshake, implemented from the RFC

`apps/relay/src/rfb-handshake.ts` implements RFC 6143 §7.1–7.3 directly:

1. **ProtocolVersion exchange** — read the server's 12-byte version line, reply with `RFB 003.008\n`.
2. **Security handshake** — read the server's offered security-type list; prefer VNC Authentication (type 2), fall back to None (type 1); refuse if neither is offered.
3. **VNC-Auth challenge/response** (if applicable) — read the 16-byte challenge, encrypt it with the password-derived DES key, write the 16-byte response.
4. **SecurityResult** — read the 4-byte result; on failure, read and surface the server's reason text.

Any protocol violation or auth failure throws `RfbHandshakeError`, and the caller closes the socket — there is no fallback to passing an unauthenticated connection through.

## The DES cryptography

`apps/relay/src/vnc-auth.ts`. RFC 6143's VNC Authentication requires a genuinely odd step: the password's DES key bytes must be used **bit-reversed** compared to normal DES key convention — a documented quirk of the original RFB spec, not an implementation choice.

**A real compatibility problem, solved and verified before relying on it:** Node's OpenSSL 3.x build disables single-DES-ECB by default (a "legacy" algorithm, `error:0308010C:digital envelope routines::unsupported`). The fix uses a real cryptographic identity — Triple-DES-EDE3 with all three sub-keys set equal to the same 8-byte key mathematically degenerates to plain single-DES encryption, because `E(D(E(x,K),K),K) = E(x,K)` (the middle decrypt undoes the first encrypt). This was verified empirically — a deterministic 8-byte ciphertext from `des-ede3-ecb` with a tripled key — before the relay was built on top of it.

## A real bug this caught, and how

The first test run of `apps/relay/test/rfb-handshake.test.ts` **hung and timed out on all 5 tests.** The cause: the original `readExact()` implementation attached a fresh `socket.on('data', ...)` listener per read, and used `socket.unshift(remainder)` to push back any bytes read past the requested length. `socket.unshift()` does not reliably re-flow buffered data to a freshly-attached listener in Node — a genuine stream-handling footgun, confirmed by direct instrumentation (a debug script showed the unshifted byte was received but the *next* `readExact` call never got a `'data'` event for it).

**The fix:** `apps/relay/src/buffered-reader.ts` — a persistent `BufferedReader` class that attaches exactly one `'data'` listener for the socket's entire lifetime, accumulates into an internal buffer, and resolves a FIFO queue of pending reads as soon as enough bytes have arrived. No `unshift()`, no listener churn.

After the fix, all 16 relay tests pass, including one specifically written to prove the handshake's byte-level correctness: encrypting two different second-challenge-halves with the same first half must leave the first 8 bytes of the response identical and only the second 8 bytes differ — proving the two DES blocks really are encrypted independently, per spec, not accidentally chained.

## What exceeds plain TightVNC/MightyViewer, and why it matters for a fleet

| | TightVNC / MightyViewer | This system |
|---|---|---|
| Access | Same LAN or a forwarded port | Brokered from anywhere; no inbound port at any branch, ever |
| Credentials | Operator types a shared password | Vault-injected server-side; the operator never sees it |
| Client | Installed Windows viewer | Browser — any OS, any device |
| Audit | None | Every session recorded in `sessions`, non-dismissible "being audited" banner |
| Recovery | Manual reconnect | (Planned) resumable sessions — see [14-status-and-roadmap.md](./14-status-and-roadmap.md) for what's not yet built |

## The noVNC viewer

`apps/web/components/viewer/NoVncCanvas.tsx`. Wraps `@novnc/novnc`'s `RFB` class, dynamically imported client-side. `mode="view"` maps to noVNC's `viewOnly` flag — there is no client-side way to escalate a view session into control. The permanent banner ("● Session being audited — view only" when applicable) cannot be dismissed.

## What's not built yet

- **Thumbnail sampler / monitoring wall** — the MightyViewer-style live-preview grid. Not implemented; the relay currently only supports full interactive sessions, one connection per viewer.
- **Session recording playback** — `sessions.recording_ref` exists as a column, but nothing writes an actual recording yet.
- **Go port** — planned for the thumbnail-wall load case; the Node relay is adequate for interactive sessions at the current scale (44 branches) and was the pragmatic build-order choice since Go isn't installed in this environment.
- **Full RFB encoding decoders** (Tight, ZRLE, Hextile, etc.) inside the relay itself — not needed for the current design, since the relay is a byte pipe after auth and noVNC handles encodings client-side. Would only become relevant if the relay needed to decode frames itself (e.g., for the thumbnail sampler).
