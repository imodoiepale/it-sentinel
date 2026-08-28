import { Socket } from "node:net";

/**
 * Reads exact byte counts off a socket without the data-loss/re-flow
 * problems of the on/off-listener-per-read pattern: `socket.unshift()`
 * does not reliably re-emit 'data' to a freshly attached listener, which
 * silently hung the handshake (caught by rfb-handshake.test.ts before this
 * ever ran against a real server — exactly what that test suite is for).
 *
 * Instead, this attaches exactly one 'data' listener for the socket's
 * lifetime, accumulates into an internal buffer, and resolves pending
 * readExact() calls as soon as enough bytes have arrived — a small FIFO of
 * pending readers rather than an on-demand listener per read.
 */
export class BufferedReader {
  private buffer = Buffer.alloc(0);
  private pending: { length: number; resolve: (b: Buffer) => void; reject: (e: Error) => void }[] = [];
  private closed = false;
  private closeError: Error | null = null;

  constructor(private readonly socket: Socket) {
    socket.on("data", (chunk: Buffer) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      this.drain();
    });
    socket.on("error", (err: Error) => this.fail(err));
    socket.on("close", () => this.fail(new Error("socket closed before enough bytes were read")));
  }

  private drain() {
    while (this.pending.length > 0 && this.buffer.length >= this.pending[0].length) {
      const { length, resolve } = this.pending.shift()!;
      const exact = this.buffer.subarray(0, length);
      this.buffer = this.buffer.subarray(length);
      resolve(Buffer.from(exact));
    }
  }

  private fail(err: Error) {
    if (this.closed) return;
    this.closed = true;
    this.closeError = err;
    for (const p of this.pending) p.reject(err);
    this.pending = [];
  }

  readExact(length: number): Promise<Buffer> {
    if (this.closed) return Promise.reject(this.closeError ?? new Error("reader closed"));
    return new Promise((resolve, reject) => {
      this.pending.push({ length, resolve, reject });
      this.drain();
    });
  }

  /** Any bytes buffered but not yet consumed by a readExact call — handed to the raw pipe once the handshake completes. */
  takeRemainder(): Buffer {
    const remainder = this.buffer;
    this.buffer = Buffer.alloc(0);
    return remainder;
  }
}
