import type { FastifyReply, FastifyRequest } from 'fastify';
import { liveBus, type LiveEvent } from './bus';

/**
 * Server-sent-event streams with admission control.
 *
 * The live feeds are deliberately unauthenticated — the leaderboard and the
 * bracket are public — so the only thing standing between the process and an
 * unbounded pile of sockets, bus listeners and heartbeat timers is what this
 * module enforces:
 *
 *  - a global cap and a per-client cap on concurrent streams, rejected with
 *    503 + Retry-After rather than accepted and left to accumulate;
 *  - a maximum stream lifetime, so cleanup never depends on a client that has
 *    no intention of hanging up (EventSource reconnects on its own, so a
 *    server-initiated close is invisible to a real browser);
 *  - a buffered-bytes ceiling, so a consumer that stops reading is closed
 *    instead of growing the socket's write buffer without limit.
 *
 * Every path out of a stream runs the same teardown exactly once, which is why
 * the listener count returns to zero rather than to "however many clients
 * happened to disconnect politely".
 */

export interface SseLimits {
  /** Concurrent streams across the whole process. */
  maxConnections: number;
  /** Concurrent streams from one client address. */
  maxConnectionsPerIp: number;
  /** Server-initiated close after this long, regardless of client behaviour. */
  maxStreamMs: number;
  /** Close a stream whose unflushed write buffer exceeds this. */
  maxBufferedBytes: number;
  /** Heartbeat comment interval, keeping proxies from idling the stream out. */
  heartbeatMs: number;
}

export class SseRegistry {
  private total = 0;
  private readonly perIp = new Map<string, number>();

  constructor(private readonly limits: SseLimits) {
    // One listener per open stream is by design; the cap is what bounds it, so
    // raise Node's warning threshold to match rather than letting a healthy
    // full house look like a leak.
    liveBus.setMaxListeners(Math.max(limits.maxConnections * 2, 20));
  }

  /** Open streams right now — exposed for tests and diagnostics. */
  get openConnections(): number {
    return this.total;
  }

  /**
   * Begin a stream, or reject it. Returns false when the request was refused,
   * in which case nothing has been allocated for it.
   */
  start(request: FastifyRequest, reply: FastifyReply, tournamentId?: string): boolean {
    const ip = request.ip;
    if (this.total >= this.limits.maxConnections || (this.perIp.get(ip) ?? 0) >= this.limits.maxConnectionsPerIp) {
      void reply.status(503).header('Retry-After', '30').send({ error: 'too many live connections' });
      return false;
    }

    this.total += 1;
    this.perIp.set(ip, (this.perIp.get(ip) ?? 0) + 1);

    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    reply.raw.write(': connected\n\n');

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(heartbeat);
      clearTimeout(lifetime);
      unsubscribe();
      this.total -= 1;
      const remaining = (this.perIp.get(ip) ?? 1) - 1;
      if (remaining > 0) this.perIp.set(ip, remaining);
      else this.perIp.delete(ip);
      reply.raw.end();
    };

    /**
     * Write, unless the peer has stopped draining. `writableLength` is what is
     * still queued in userland; past the ceiling the client is not reading and
     * further writes only cost us memory.
     */
    const write = (chunk: string): void => {
      if (closed) return;
      if (reply.raw.writableLength > this.limits.maxBufferedBytes) {
        close();
        return;
      }
      reply.raw.write(chunk);
    };

    const send = (event: LiveEvent): void => {
      write(`event: ${event.type}\ndata: ${JSON.stringify(event.payload ?? {})}\n\n`);
    };

    const unsubscribe = liveBus.subscribe(send, tournamentId);
    const heartbeat = setInterval(() => write(': heartbeat\n\n'), this.limits.heartbeatMs);
    const lifetime = setTimeout(close, this.limits.maxStreamMs);
    // Neither timer should hold the process open on shutdown.
    heartbeat.unref?.();
    lifetime.unref?.();

    request.raw.on('close', close);
    reply.raw.on('close', close);
    reply.raw.on('error', close);

    return true;
  }
}
