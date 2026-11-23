/**
 * When another device last used this library.
 *
 * A laptop running Raazi goes to sleep like any other: Windows idles it into
 * standby a few minutes after the last key press, and takes the Wi-Fi down
 * seconds later. Nothing about that looks at whether a phone across the room
 * is in the middle of a book served from here — from the phone the library
 * simply stops answering, and comes back when somebody touches the laptop
 * (23 Nov 2026: thirteen such standbys in one working day, each one a
 * "connection lost" on the phone).
 *
 * The launcher is the one that can ask Windows to stay up, and this is what it
 * asks by: the middleware notes every signed-in request that did not come from
 * this computer, and GET /api/presence says how long ago the last one was.
 *
 * Only requests that carried the token count. /api/hello is open so that a
 * phone can find the machine, which also means any device on the Wi-Fi can
 * call it; a stranger's subnet sweep must not be able to hold a laptop awake.
 *
 * Kept on globalThis because the middleware and the routes are built as
 * separate bundles: a module-level variable would be two variables.
 */

declare global {
  // eslint-disable-next-line no-var
  var __corpusRemoteSeenAt: number | undefined;
}

/** Whether an address is this computer talking to itself. */
export function isLoopback(address: string): boolean {
  const a = address.trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (!a) return false;
  if (a === "::1" || a === "localhost") return true;
  // ::ffff:127.0.0.1 is how a dual-stack socket reports an IPv4 caller.
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/**
 * The caller's address out of x-forwarded-for, which Next fills in from the
 * socket. The last entry is the one this server wrote itself; anything before
 * it came from the caller and is only a claim.
 */
export function callerAddress(forwardedFor: string | null): string | null {
  if (!forwardedFor) return null;
  const parts = forwardedFor.split(",").map((p) => p.trim()).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

/**
 * Notes a signed-in request. An address that cannot be read counts as this
 * computer: staying awake for nobody is the worse of the two mistakes.
 */
export function noteRequest(forwardedFor: string | null, now = Date.now()): void {
  const address = callerAddress(forwardedFor);
  if (!address || isLoopback(address)) return;
  globalThis.__corpusRemoteSeenAt = now;
}

/** Milliseconds since another device last used the library; null when none has. */
export function remoteSeenAgoMs(now = Date.now()): number | null {
  const at = globalThis.__corpusRemoteSeenAt;
  return typeof at === "number" ? Math.max(0, now - at) : null;
}
