/**
 * Client-visible environment variables.
 *
 * Next.js inlines NEXT_PUBLIC_* at build time, so these values are captured as
 * constants. Fallbacks make local dev work without a .env file.
 */
export const API_URL: string =
  process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:8000";

export const WS_URL: string =
  process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:4001";

export const INSTANCE_LABEL: string =
  process.env.NEXT_PUBLIC_INSTANCE_LABEL ?? "dev";
