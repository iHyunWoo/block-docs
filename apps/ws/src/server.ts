/**
 * WebSocket server entrypoint.
 *
 * Responsibilities:
 *   - Accept ws://host:port/v3/docs/:docId?sinceStreamId=<id>&uid=<int>
 *   - Validate path/query, attach SocketContext
 *   - Join/leave Rooms
 *   - Replay stream entries since the client's cursor
 *   - Route messages to the crdt / ops / awareness handlers
 *   - Heartbeat (ping every 30s, terminate if no pong within 10s)
 *   - Graceful shutdown on SIGTERM/SIGINT
 */
import http from 'node:http';
import { URL } from 'node:url';
import Redis from 'ioredis';
import { WebSocketServer, type WebSocket } from 'ws';

import { loadConfig, type Config } from './config.js';
import { createLogger, type Logger } from './logger.js';
import { RoomRegistry } from './room.js';
import { wireBusSubscriber } from './bus.js';
import { runReplay, RELOAD_REQUIRED_CLOSE_CODE } from './replay.js';
import { handleCrdt } from './handlers/crdt.js';
import { handleOps } from './handlers/ops.js';
import { handleAwareness } from './handlers/awareness.js';
import { parseClientMessage } from './protocol.js';
import type { ContextedSocket, RedisLike, SocketContext } from './types.js';

const PATH_RE = /^\/v3\/docs\/(\d+)$/;

export interface StartOptions {
  config?: Partial<Config>;
  /** Inject a custom redis publisher (tests). */
  redis?: RedisLike;
  /** Inject a custom redis subscriber (tests). */
  subscriber?: RedisLike;
  /** Inject a custom fetch implementation for ops forwarding (tests). */
  fetchImpl?: typeof fetch;
  /** When true, suppress SIGTERM/SIGINT wiring (tests manage shutdown). */
  skipSignalHandlers?: boolean;
}

export interface RunningServer {
  httpServer: http.Server;
  wss: WebSocketServer;
  rooms: RoomRegistry;
  shutdown: () => Promise<void>;
  port: number;
}

interface UpgradeDecision {
  ok: boolean;
  status?: number;
  reason?: string;
  ctx?: Omit<SocketContext, 'isAlive'>;
}

function decideUpgrade(req: http.IncomingMessage, instanceId: string): UpgradeDecision {
  if (!req.url) return { ok: false, status: 400, reason: 'missing_url' };
  let url: URL;
  try {
    url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);
  } catch {
    return { ok: false, status: 400, reason: 'invalid_url' };
  }

  const pathMatch = PATH_RE.exec(url.pathname);
  if (!pathMatch) {
    return { ok: false, status: 404, reason: 'path_not_found' };
  }
  const docIdStr = pathMatch[1];
  if (!docIdStr) return { ok: false, status: 400, reason: 'invalid_doc_id' };
  const docId = Number(docIdStr);
  if (!Number.isInteger(docId) || docId <= 0) {
    return { ok: false, status: 400, reason: 'invalid_doc_id' };
  }

  const uidStr = url.searchParams.get('uid');
  if (!uidStr) return { ok: false, status: 400, reason: 'missing_uid' };
  const userId = Number(uidStr);
  if (!Number.isInteger(userId) || userId <= 0) {
    return { ok: false, status: 400, reason: 'invalid_uid' };
  }

  const sinceStreamId = url.searchParams.get('sinceStreamId');

  return {
    ok: true,
    ctx: {
      docId,
      userId,
      instanceId,
      sinceStreamId: sinceStreamId && sinceStreamId.length > 0 ? sinceStreamId : null,
    },
  };
}

function attachCtx(ws: WebSocket, ctx: SocketContext): ContextedSocket {
  (ws as ContextedSocket).ctx = ctx;
  return ws as ContextedSocket;
}

export async function start(opts: StartOptions = {}): Promise<RunningServer> {
  const config = { ...loadConfig(), ...opts.config } as Config;
  const logger = createLogger(config.instanceId, config.logLevel);

  // Redis clients. A fresh subscriber is required (ioredis enters subscribe
  // mode exclusively). We disable enableReadyCheck/offlineQueue on the
  // subscriber so ioredis won't issue background INFO commands that Redis
  // rejects while the connection is in subscribe mode.
  const redis: RedisLike = opts.redis ?? (new Redis(config.redisUrl) as unknown as RedisLike);
  const subscriber: RedisLike =
    opts.subscriber ??
    (new Redis(config.redisUrl, {
      enableReadyCheck: false,
      maxRetriesPerRequest: null,
    }) as unknown as RedisLike);

  // Surface redis errors early so operators see them.
  subscriber.on('error', (err) => logger.error({ err: err.message }, 'redis_sub_error'));
  (redis as unknown as { on: (e: string, l: (err: Error) => void) => void }).on(
    'error',
    (err: Error) => logger.error({ err: err.message }, 'redis_pub_error'),
  );

  const rooms = new RoomRegistry({
    subscriber,
    onFirstJoin: (docId) => logger.info({ docId }, 'room_first_join'),
    onLastLeave: (docId) => logger.info({ docId }, 'room_last_leave'),
  });

  wireBusSubscriber({ instanceId: config.instanceId, subscriber, rooms, logger });

  const httpServer = http.createServer((req, res) => {
    // We only speak WS. Anything else gets a minimal 426.
    res.statusCode = 426;
    res.setHeader('content-type', 'text/plain');
    res.end('Upgrade required');
  });

  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const decision = decideUpgrade(req, config.instanceId);
    if (!decision.ok || !decision.ctx) {
      logger.info({ url: req.url, reason: decision.reason }, 'upgrade_rejected');
      socket.write(
        `HTTP/1.1 ${decision.status ?? 400} ${decision.reason ?? 'Bad Request'}\r\n\r\n`,
      );
      socket.destroy();
      return;
    }
    const ctx: SocketContext = { ...decision.ctx, isAlive: true };
    wss.handleUpgrade(req, socket, head, (ws) => {
      const cs = attachCtx(ws, ctx);
      wss.emit('connection', cs, req);
    });
  });

  wss.on('connection', async (ws: WebSocket) => {
    const cs = ws as ContextedSocket;
    const { docId, userId, sinceStreamId } = cs.ctx;
    logger.info({ docId, userId, sinceStreamId }, 'ws_connected');

    // Heartbeat state
    cs.ctx.isAlive = true;
    cs.on('pong', () => {
      cs.ctx.isAlive = true;
    });

    try {
      await rooms.join(docId, cs);
    } catch (err) {
      logger.error({ docId, err: (err as Error).message }, 'room_join_failed');
      cs.close(1011, 'room_join_failed');
      return;
    }

    // Send hello. Since we don't yet know the stream's tail until we do XRANGE
    // during replay (or the client sent no cursor), we echo back what the
    // client supplied so they can reconcile.
    sendFrame(cs, {
      ch: 'hello',
      userId,
      lastStreamId: sinceStreamId ?? '0-0',
    });

    // Replay, if requested.
    if (sinceStreamId) {
      try {
        const result = await runReplay({
          redis,
          docId,
          sinceStreamId,
          ws: cs,
          logger,
        });
        if (result.trimmed) {
          // runReplay already closed the socket.
          return;
        }
        logger.debug(
          { docId, userId, framesSent: result.framesSent, lastStreamId: result.lastStreamId },
          'replay_completed',
        );
      } catch (err) {
        logger.error({ docId, userId, err: (err as Error).message }, 'replay_failed');
        cs.close(1011, 'replay_failed');
        return;
      }
    }

    cs.on('message', async (raw) => {
      const text = typeof raw === 'string' ? raw : raw.toString('utf8');
      const parsed = parseClientMessage(text);
      if (!parsed.ok) {
        logger.warn({ docId, userId, err: parsed.error }, 'bad_client_message');
        return;
      }
      const msg = parsed.msg;

      try {
        switch (msg.ch) {
          case 'crdt':
            await handleCrdt(
              {
                redis,
                rooms,
                instanceId: config.instanceId,
                streamMaxLen: config.streamMaxLen,
                logger,
              },
              cs,
              msg,
            );
            break;
          case 'ops':
            await handleOps({ apiUrl: config.apiUrl, logger, fetchImpl: opts.fetchImpl }, cs, msg);
            break;
          case 'awareness':
            handleAwareness({ rooms }, cs, msg);
            break;
          default: {
            // Exhaustiveness — zod's discriminatedUnion already enforces this,
            // but we defend in depth.
            const _never: never = msg;
            logger.warn({ msg: _never }, 'unknown_channel');
          }
        }
      } catch (err) {
        logger.error({ docId, userId, ch: msg.ch, err: (err as Error).message }, 'handler_failed');
      }
    });

    cs.on('close', async (code) => {
      logger.info({ docId, userId, code }, 'ws_closed');
      try {
        await rooms.leave(docId, cs);
      } catch (err) {
        logger.error({ docId, err: (err as Error).message }, 'room_leave_failed');
      }
    });

    cs.on('error', (err) => {
      logger.warn({ docId, userId, err: err.message }, 'ws_socket_error');
    });
  });

  // Heartbeat: ping every N ms, terminate any socket that hasn't ponged since
  // the previous interval.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      const cs = ws as ContextedSocket;
      if (!cs.ctx) continue;
      if (!cs.ctx.isAlive) {
        logger.info({ docId: cs.ctx.docId, userId: cs.ctx.userId }, 'ws_heartbeat_timeout');
        try {
          cs.terminate();
        } catch {
          // ignore
        }
        continue;
      }
      cs.ctx.isAlive = false;
      try {
        cs.ping();
      } catch {
        // ignore — terminate on next tick
      }
    }
  }, config.heartbeatIntervalMs);
  heartbeat.unref?.();

  const port = config.port;
  await new Promise<void>((resolve) => {
    httpServer.listen(port, () => resolve());
  });
  const boundPort = (httpServer.address() as { port: number } | null)?.port ?? port;
  logger.info({ port: boundPort }, 'ws_server_listening');

  // Graceful shutdown
  let shuttingDown = false;
  const shutdown = async () => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({}, 'shutdown_start');
    clearInterval(heartbeat);
    httpServer.close();

    // Close all sockets with 1012 (service restart).
    for (const ws of wss.clients) {
      try {
        ws.close(1012, 'server_shutdown');
      } catch {
        // ignore
      }
    }

    // Give in-flight xadds / bus publishes a moment to settle. We don't hold
    // any state past what's already in-flight on the redis client.
    await new Promise((r) => setTimeout(r, 250));

    try {
      await redis.quit();
    } catch {
      // ignore
    }
    try {
      await subscriber.quit();
    } catch {
      // ignore
    }

    wss.close();
    logger.info({}, 'shutdown_complete');
  };

  if (!opts.skipSignalHandlers) {
    const onSignal = (sig: string) => {
      logger.info({ sig }, 'signal_received');
      shutdown().then(
        () => process.exit(0),
        (err) => {
          logger.error({ err: (err as Error).message }, 'shutdown_failed');
          process.exit(1);
        },
      );
    };
    process.once('SIGTERM', () => onSignal('SIGTERM'));
    process.once('SIGINT', () => onSignal('SIGINT'));
  }

  return { httpServer, wss, rooms, shutdown, port: boundPort };
}

function sendFrame(ws: ContextedSocket, frame: unknown): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

// Entrypoint — only run when invoked directly (not when imported by tests).
const invokedDirectly =
  import.meta.url === `file://${process.argv[1]}` ||
  (process.argv[1]?.endsWith('/server.js') ?? false) ||
  (process.argv[1]?.endsWith('/server.ts') ?? false);

if (invokedDirectly) {
  start().catch((err) => {
    // eslint-disable-next-line no-console
    console.error(JSON.stringify({ msg: 'boot_failed', err: (err as Error).message }));
    process.exit(1);
  });
}

// Re-export for convenience.
export { RELOAD_REQUIRED_CLOSE_CODE };
