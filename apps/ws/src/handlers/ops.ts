/**
 * ops channel handler.
 *
 * The WS server does NOT validate block ops or touch the db. It forwards to
 * the api server, which does optimistic-lock validation, persists, XADDs to
 * the stream, and PUBLISHes the remote_ops frame to the bus.
 *
 *   Client --(ops)--> WS --(POST)--> api --(XADD + PUBLISH)--> all instances
 *                           ↑
 *                    returns { results, streamId }
 *
 * WS responds with ack (or nack on 409/5xx). The bus listener (bus.ts)
 * delivers the remote_ops frame to our local Room too, since the api's
 * originInstance is "api" (never equal to our own instanceId).
 */
import type { Logger } from 'pino';
import type { ContextedSocket } from '../types.js';
import type { ClientOpsMessage, ConflictInfo, OpResult, ServerMessage } from '../protocol.js';

export interface OpsHandlerDeps {
  apiUrl: string;
  logger: Logger;
  /** Overridable for tests. */
  fetchImpl?: typeof fetch;
}

interface ApiOpsResponse {
  results?: OpResult[];
  streamId?: string;
  conflicts?: ConflictInfo[];
  detail?: string;
}

export async function handleOps(
  deps: OpsHandlerDeps,
  ws: ContextedSocket,
  msg: ClientOpsMessage,
): Promise<void> {
  const { apiUrl, logger } = deps;
  const fetchFn = deps.fetchImpl ?? fetch;
  const { docId, userId } = ws.ctx;
  const url = `${apiUrl.replace(/\/$/, '')}/api/v1/docs/${docId}/operations`;

  let res: Response;
  try {
    res = await fetchFn(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        // Demo auth scheme mirrors the api's cookie-based uid extraction
        // (see docs/protocol.md — "uid cookie").
        cookie: `uid=${userId}`,
      },
      body: JSON.stringify({ clientSeq: msg.clientSeq, ops: msg.ops }),
    });
  } catch (err) {
    logger.error(
      { docId, userId, clientSeq: msg.clientSeq, err: (err as Error).message },
      'ops_forward_network_error',
    );
    sendNack(ws, msg.clientSeq, [
      { blockId: msg.ops[0]?.blockId ?? '', reason: 'api_unreachable' },
    ]);
    return;
  }

  let body: ApiOpsResponse | null = null;
  try {
    body = (await res.json()) as ApiOpsResponse;
  } catch {
    body = null;
  }

  if (res.status === 409) {
    sendNack(
      ws,
      msg.clientSeq,
      body?.conflicts ?? [{ blockId: msg.ops[0]?.blockId ?? '', reason: 'conflict' }],
    );
    return;
  }

  if (res.status >= 500 || res.status >= 400) {
    logger.warn(
      { docId, userId, clientSeq: msg.clientSeq, status: res.status },
      'ops_forward_error_status',
    );
    sendNack(ws, msg.clientSeq, [
      {
        blockId: msg.ops[0]?.blockId ?? '',
        reason: body?.detail ?? `api_error_${res.status}`,
      },
    ]);
    return;
  }

  const results = body?.results ?? [];
  const frame: ServerMessage = { ch: 'ack', clientSeq: msg.clientSeq, results };
  sendFrame(ws, frame);

  // Note: we do NOT XADD or PUBLISH here. The api already did both. The bus
  // listener will fan out the remote_ops frame to our local Room (the api's
  // originInstance is not our instanceId, so the filter accepts it).
}

function sendFrame(ws: ContextedSocket, frame: ServerMessage): void {
  if (ws.readyState !== ws.OPEN) return;
  ws.send(JSON.stringify(frame));
}

function sendNack(ws: ContextedSocket, clientSeq: number, conflicts: ConflictInfo[]): void {
  sendFrame(ws, { ch: 'nack', clientSeq, conflicts });
}
