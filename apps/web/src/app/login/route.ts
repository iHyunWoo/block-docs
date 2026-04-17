import { NextResponse } from "next/server";

/**
 * Demo-only login. GET /login?uid=<int> sets the `uid` cookie and redirects
 * to /docs/1. We use a Route Handler (not a Server Component) because App
 * Router forbids cookie mutation inside page renders.
 */
export function GET(request: Request) {
  const url = new URL(request.url);
  const raw = url.searchParams.get("uid") ?? "";
  const uid = parseInt(raw, 10);

  // Construct redirect URL using the forwarded host (docker-compose maps
  // container port 3000 to host 3001/3002 — we must not echo the container's
  // internal host back to the browser).
  const forwardedHost = request.headers.get("x-forwarded-host") ?? request.headers.get("host");
  const proto = request.headers.get("x-forwarded-proto") ?? "http";
  const base = forwardedHost ? `${proto}://${forwardedHost}` : url.origin;
  const resp = NextResponse.redirect(`${base}/docs/1`);

  if (Number.isFinite(uid) && uid > 0) {
    resp.cookies.set("uid", String(uid), {
      path: "/",
      httpOnly: false,
      sameSite: "lax",
      maxAge: 60 * 60 * 24 * 30,
    });
  }
  return resp;
}
