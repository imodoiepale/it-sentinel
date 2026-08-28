import { describe, expect, it, afterEach } from "vitest";
import { createServer, Server, Socket, createConnection } from "node:net";
import { performVncAuthHandshake, RfbHandshakeError } from "../src/rfb-handshake.js";
import { encryptVncChallenge } from "../src/vnc-auth.js";

/**
 * End-to-end handshake tests against a real TCP server that speaks RFB
 * exactly per RFC 6143 — this proves the state machine itself, not just
 * the crypto in isolation. Real interop against an actual TightVNC Server
 * is a separate manual verification step (see the plan's "Remote session
 * end-to-end" test), since that requires a live Windows target.
 */

let server: Server | null = null;
let port = 0;

afterEach(() => {
  server?.close();
  server = null;
});

function startMockRfbServer(handler: (socket: Socket) => void): Promise<number> {
  return new Promise((resolve) => {
    server = createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const addr = server!.address();
      port = typeof addr === "object" && addr ? addr.port : 0;
      resolve(port);
    });
  });
}

function connect(p: number): Promise<Socket> {
  return new Promise((resolve) => {
    const socket = createConnection({ port: p, host: "127.0.0.1" }, () => resolve(socket));
  });
}

describe("performVncAuthHandshake", () => {
  it("completes successfully against a server offering VNC Authentication with the correct password", async () => {
    const password = "branch-secret";
    const challenge = Buffer.alloc(16);
    for (let i = 0; i < 16; i++) challenge[i] = i;
    const expectedResponse = encryptVncChallenge(password, challenge);

    const p = await startMockRfbServer((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => {
        // client version reply consumed
        socket.write(Buffer.from([1, 2])); // 1 type offered: VNC Auth (2)
        socket.once("data", (chosen) => {
          expect(chosen[0]).toBe(2);
          socket.write(challenge);
          socket.once("data", (response) => {
            const ok = (response as Buffer).equals(expectedResponse);
            const result = Buffer.alloc(4);
            result.writeUInt32BE(ok ? 0 : 1, 0);
            socket.write(result);
          });
        });
      });
    });

    const socket = await connect(p);
    await expect(performVncAuthHandshake(socket, password)).resolves.toEqual({ leftover: Buffer.alloc(0) });
    socket.destroy();
  });

  it("fails when the password is wrong", async () => {
    const challenge = Buffer.alloc(16, 7);
    const correctResponse = encryptVncChallenge("real-password", challenge);

    const p = await startMockRfbServer((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => {
        socket.write(Buffer.from([1, 2]));
        socket.once("data", () => {
          socket.write(challenge);
          socket.once("data", (response) => {
            const ok = (response as Buffer).equals(correctResponse);
            const result = Buffer.alloc(4);
            result.writeUInt32BE(ok ? 0 : 1, 0);
            const reason = Buffer.from("Authentication failure", "utf-8");
            const reasonLen = Buffer.alloc(4);
            reasonLen.writeUInt32BE(reason.length, 0);
            socket.write(Buffer.concat([result, reasonLen, reason]));
          });
        });
      });
    });

    const socket = await connect(p);
    await expect(performVncAuthHandshake(socket, "wrong-password")).rejects.toThrow(RfbHandshakeError);
    socket.destroy();
  });

  it("succeeds without a challenge when the server only offers security type None", async () => {
    const p = await startMockRfbServer((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => {
        socket.write(Buffer.from([1, 1])); // 1 type offered: None (1)
        socket.once("data", (chosen) => {
          expect(chosen[0]).toBe(1);
          const result = Buffer.alloc(4); // 0 = OK
          socket.write(result);
        });
      });
    });

    const socket = await connect(p);
    await expect(performVncAuthHandshake(socket, "unused")).resolves.toEqual({ leftover: Buffer.alloc(0) });
    socket.destroy();
  });

  it("throws when the server refuses the connection outright (0 security types)", async () => {
    const p = await startMockRfbServer((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => {
        const reason = Buffer.from("Too many connections", "utf-8");
        const reasonLen = Buffer.alloc(4);
        reasonLen.writeUInt32BE(reason.length, 0);
        socket.write(Buffer.concat([Buffer.from([0]), reasonLen, reason]));
      });
    });

    const socket = await connect(p);
    await expect(performVncAuthHandshake(socket, "unused")).rejects.toThrow(/refused connection/);
    socket.destroy();
  });

  it("throws when the server offers neither VNC Authentication nor None", async () => {
    const p = await startMockRfbServer((socket) => {
      socket.write(Buffer.from("RFB 003.008\n", "ascii"));
      socket.once("data", () => {
        socket.write(Buffer.from([1, 16])); // type 16 = Tight, unsupported here
      });
    });

    const socket = await connect(p);
    await expect(performVncAuthHandshake(socket, "unused")).rejects.toThrow(/does not offer/);
    socket.destroy();
  });
});
