import { NextResponse, type NextRequest } from "next/server";
import {
  LAN_COOKIE,
  ensureLanToken,
  lanEnabled,
  lanSettings,
  loginUrls,
  signInPage,
  tokenFrom,
  tokenMatches,
} from "./lib/lan";

/**
 * The door, when there is one.
 *
 * With LAN mode off — the default — Corpus is bound to 127.0.0.1 and this
 * passes everything through: the only client that can reach it is you. With
 * LAN mode on, every request has to carry the token (see lib/lan.ts), because
 * the server is now reachable by whatever else is on the network, and "the
 * network" on a reporting trip means a hotel.
 *
 * Two routes stay open. `GET /api/hello` is how a phone finds this machine by
 * sweeping the subnet — it reports counts, never content — and `GET /login` is
 * how a browser signs in: `/login?token=…` sets the cookie and sends you to
 * the front page. Everything else without the token gets a 401: JSON for the
 * API, a small sign-in page for anything a person would be looking at.
 *
 * Runs on the Node runtime rather than the edge one because the token lives
 * in data/config.json and the edge sandbox has no filesystem.
 */
export const config = { runtime: "nodejs" };

const YEAR = 60 * 60 * 24 * 365;

/**
 * The app's manifest and its icons: what lets a browser offer to install
 * Corpus as its own window, which it asks for before anyone has signed in.
 * Fixed names, read-only, and none of them says anything about the library.
 */
const APP_FILES = new Set(["/manifest.webmanifest", "/icon-192.png", "/icon-512.png", "/icon-maskable-512.png"]);

/** Printed once per process, so `npm run dev:lan` tells you where to sign in. */
let announced = false;

export async function middleware(req: NextRequest) {
  if (!lanEnabled()) return NextResponse.next();

  const { pathname, searchParams } = req.nextUrl;

  // Discovery must work before anyone has signed in, or nothing ever could.
  if (req.method === "GET" && pathname === "/api/hello") return NextResponse.next();
  if (req.method === "GET" && APP_FILES.has(pathname)) return NextResponse.next();

  // LAN mode switched on by the environment alone has no token yet; the first
  // request makes one. Fail closed in the meantime — never open.
  let token = lanSettings().token;
  if (!token) token = await ensureLanToken();

  if (!announced) {
    announced = true;
    const port = Number(req.nextUrl.port || process.env.PORT || 5400);
    const urls = loginUrls(port, token);
    console.log(
      `[corpus] LAN mode is on. Sign in from a phone at:\n` +
        (urls.length ? urls.map((u) => `  ${u}`).join("\n") : "  (no network address found)")
    );
  }

  if (pathname === "/login") {
    if (req.method !== "GET") return new NextResponse(null, { status: 405 });
    const offered = searchParams.get("token");
    if (offered && tokenMatches(offered, token)) {
      const res = NextResponse.redirect(new URL("/", req.url));
      // Lax rather than Strict so a link from another app on the phone (the
      // helper, a QR scanner) still arrives signed in. Not Secure: there is no
      // certificate on a LAN, and the cookie would never be sent at all.
      res.cookies.set(LAN_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        path: "/",
        maxAge: YEAR,
      });
      return res;
    }
    if (tokenMatches(tokenFrom(req), token)) {
      return NextResponse.redirect(new URL("/", req.url));
    }
    return html(
      offered
        ? "That token is not the one this Corpus is using."
        : "This Corpus is in LAN mode, so it needs its token before it will open.",
      offered ? 401 : 200
    );
  }

  if (tokenMatches(tokenFrom(req), token)) return NextResponse.next();

  if (pathname.startsWith("/api/")) {
    return NextResponse.json(
      { error: "This Corpus is in LAN mode. Send its token as x-corpus-token, or sign in at /login." },
      { status: 401 }
    );
  }
  return html("This Corpus is in LAN mode, so it needs its token before it will open.", 401);
}

function html(reason: string, status: number) {
  return new NextResponse(signInPage(reason), {
    status,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}
