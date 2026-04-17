/**
 * Process configuration read from environment variables.
 *
 * All values here are immutable for the process lifetime. If something needs
 * to change at runtime, it does not belong here.
 */

export interface Config {
  port: number;
  instanceId: string;
  redisUrl: string;
  apiUrl: string;
  streamMaxLen: number;
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  logLevel: string;
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || !Number.isInteger(n)) {
    throw new Error(`invalid int for env ${name}: ${raw}`);
  }
  return n;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  return {
    port: envInt('PORT', 4000),
    instanceId: env.INSTANCE_ID ?? 'ws-local',
    redisUrl: env.REDIS_URL ?? 'redis://localhost:6379/0',
    apiUrl: env.API_URL ?? 'http://localhost:8000',
    streamMaxLen: envInt('STREAM_MAXLEN', 100_000),
    heartbeatIntervalMs: envInt('HEARTBEAT_INTERVAL_MS', 30_000),
    heartbeatTimeoutMs: envInt('HEARTBEAT_TIMEOUT_MS', 10_000),
    logLevel: env.LOG_LEVEL ?? 'info',
  };
}
