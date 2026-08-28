import { createServer } from "node:http";
import { connect as tcpConnect } from "node:net";
import { WebSocketServer, WebSocket } from "ws";
import { createClient } from "@supabase/supabase-js";
import { performVncAuthHandshake, RfbHandshakeError } from "./rfb-handshake.js";

/**
 * The relay: browser (noVNC over WebSocket) <-> here <-> TightVNC Server
 * over raw TCP. This process holds the service-role Supabase key (same
 * boundary as the control plane) because it is the only thing that ever
 * calls decrypt_credential_for_session — never returned to the browser,
 * used exactly once to complete the RFB handshake, then dropped.
 *
 * URL shape: wss://relay/session/<singleUseToken>
 */

const SUPABASE_URL = process.env.SUPABASE_URL!;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY!;
const PORT = Number(process.env.RELAY_PORT ?? 8788);
const VNC_PORT = Number(process.env.RELAY_VNC_PORT ?? 5900);

/** How long to wait for a branch machine's VNC port before giving up. */
const CONNECT_TIMEOUT_MS = Number(process.env.RELAY_CONNECT_TIMEOUT_MS ?? 5000);

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("[relay] SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required");
  process.exit(1);
}

const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false } });

const httpServer = createServer();
const wss = new WebSocketServer({ server: httpServer });

wss.on("connection", async (ws, req) => {
  const match = req.url?.match(/^\/session\/([0-9a-f-]{36})$/i);
  if (!match) {
    ws.close(4400, "invalid session path");
    return;
  }
  const token = match[1];

  // Redeem-once: a token that has already been used, expired, or never
  // existed fails here — before we ever touch a credential or open a TCP
  // connection to a branch machine.
  const { data: redeemed, error: redeemError } = await db.rpc("redeem_session_token", { p_token: token });
  const grant = redeemed?.[0];
  if (redeemError || !grant) {
    ws.close(4401, "session token invalid, expired, or already used");
    return;
  }

  const { data: asset, error: assetError } = await db
    .from("assets")
    .select("ip, vnc_port")
    .eq("id", grant.asset_id)
    .single();
  if (assetError || !asset?.ip) {
    ws.close(4404, "asset not found or has no registered IP");
    return;
  }

  let plaintextPassword: string | null = null;
  try {
    const { data: secret, error: decryptError } = await db.rpc("decrypt_credential_for_session", {
      p_credential_id: grant.credential_id,
      p_session_id: grant.session_id,
    });
    if (decryptError || !secret) {
      ws.close(4403, "credential unavailable");
      return;
    }
    plaintextPassword = secret as string;

    // Postgres renders `inet` without a prefix for host addresses, but a row
    // written as 192.168.1.5/32 would come back with the suffix and make
    // tcpConnect fail with an unhelpful DNS error. Cheap to be defensive.
    const targetHost = String(asset.ip).split("/")[0]!;
    const targetPort = asset.vnc_port ?? VNC_PORT;

    const tcpSocket = tcpConnect({ host: targetHost, port: targetPort });

    await new Promise<void>((resolve, reject) => {
      // Without an explicit timeout an unreachable branch machine — the
      // normal case when TightVNC's firewall rule is missing, which is the
      // single most common misconfiguration — leaves the operator watching
      // a blank canvas for the OS-level TCP timeout, around 21s on Windows.
      // Failing fast with a specific message is the difference between
      // "the demo is broken" and "open port 5900 on that laptop".
      tcpSocket.setTimeout(CONNECT_TIMEOUT_MS);
      tcpSocket.once("timeout", () => {
        tcpSocket.destroy();
        reject(new Error(`timed out connecting to ${targetHost}:${targetPort} — is TightVNC running and allowed through the firewall?`));
      });
      tcpSocket.once("connect", () => {
        // Clear the connect deadline; an idle established VNC session is
        // normal and must not be torn down.
        tcpSocket.setTimeout(0);
        resolve();
      });
      tcpSocket.once("error", (err) => reject(err));
    });

    const { leftover } = await performVncAuthHandshake(tcpSocket, plaintextPassword);

    // The password's job is done — this is the one and only place it
    // existed as a variable, and it goes out of scope the moment this
    // block ends. It is never logged, never written to any response, and
    // never reaches the browser.
    plaintextPassword = null;

    console.log(`[relay] session ${grant.session_id} authenticated against ${asset.ip}, piping raw RFB from here on`);

    if (leftover.length > 0 && ws.readyState === WebSocket.OPEN) {
      ws.send(leftover);
    }

    // From this point, the relay is a dumb pipe. noVNC on the browser side
    // speaks ClientInit/ServerInit/encodings directly to the real server;
    // the relay never parses another RFB message.
    tcpSocket.on("data", (chunk) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(chunk);
    });
    ws.on("message", (data) => {
      tcpSocket.write(data as Buffer);
    });

    const cleanup = () => {
      tcpSocket.destroy();
      if (ws.readyState === WebSocket.OPEN) ws.close();
    };
    tcpSocket.on("close", cleanup);
    tcpSocket.on("error", cleanup);
    ws.on("close", cleanup);
    ws.on("error", cleanup);
  } catch (err) {
    plaintextPassword = null;
    const reason = err instanceof RfbHandshakeError ? err.message : "connection to branch machine failed";
    console.error(`[relay] session ${grant.session_id} failed:`, (err as Error).message);
    ws.close(4500, reason.slice(0, 120));
  }
});

httpServer.listen(PORT, () => console.log(`[relay] listening on :${PORT}`));
