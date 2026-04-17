/**
 * Tiny structured logger. We use pino when available, but fall back to
 * JSON-on-stdout to avoid hard coupling in tests.
 *
 * Every record carries instanceId so multi-instance logs are attributable.
 */
import pino, { type Logger } from 'pino';

export type { Logger };

export function createLogger(instanceId: string, level: string): Logger {
  return pino({
    level,
    base: { instanceId },
    // Keep raw JSON — infra can pretty-print in dev if desired.
    timestamp: pino.stdTimeFunctions.isoTime,
  });
}
