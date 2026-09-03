import dns from "node:dns/promises";
import net from "node:net";

/**
 * Fetching addresses a user (or a page) chose.
 *
 * URL ingestion and cover lookup fetch whatever they are handed and, for
 * covers, whatever og:image the fetched page declares. On a server bound to
 * every interface that is a way for anyone on the network to read the
 * machine's own services — a router admin page, a cloud metadata endpoint —
 * and have the bytes come back as "article text" or an image. A feed poller
 * fetching thousands of URLs a day makes the exposure routine rather than
 * theoretical, so the check lives in one place and every such fetch goes
 * through it.
 *
 * The rules: http(s) only; no loopback, private, link-local or otherwise
 * non-routable address, whether written as a literal or reached through DNS;
 * and redirects are followed by hand so each hop is held to the same rule,
 * because "public host that 302s to 169.254.169.254" is the classic bypass.
 */

const MAX_REDIRECTS = 5;

export class UnsafeUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsafeUrlError";
  }
}

/** Whether an IPv4 or IPv6 literal is one nobody outside this machine or its LAN could reach. */
export function isPrivateAddress(ip: string): boolean {
  const kind = net.isIP(ip);
  if (kind === 4) return isPrivateV4(ip);
  if (kind === 6) return isPrivateV6(ip);
  // Not an address at all: treat as unsafe rather than guess.
  return true;
}

function isPrivateV4(ip: string): boolean {
  const parts = ip.split(".").map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p) || p < 0 || p > 255)) return true;
  const [a, b] = parts;
  if (a === 0) return true; // "this" network
  if (a === 10) return true;
  if (a === 127) return true; // loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  if (a === 169 && b === 254) return true; // link-local, and cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (parts[2] === 0 || parts[2] === 2)) return true; // IETF, TEST-NET-1
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking
  if (a === 198 && b === 51 && parts[2] === 100) return true; // TEST-NET-2
  if (a === 203 && b === 0 && parts[2] === 113) return true; // TEST-NET-3
  if (a >= 224) return true; // multicast, reserved, broadcast
  return false;
}

function isPrivateV6(ip: string): boolean {
  const s = ip.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0];
  if (s === "::" || s === "::1") return true;
  // IPv4 written inside IPv6 (::ffff:10.0.0.1) is judged as the IPv4 it is.
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (mapped) return isPrivateV4(mapped[1]);
  // The same in hex form, as some resolvers return it.
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(s);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    return isPrivateV4(`${hi >> 8}.${hi & 255}.${lo >> 8}.${lo & 255}`);
  }
  if (s.startsWith("64:ff9b:")) return true; // NAT64 — could reach anything behind it
  const first = parseInt(s.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((first & 0xff00) === 0xff00) return true; // multicast
  if (s.startsWith("2001:db8:")) return true; // documentation
  return false;
}

/** Host names that resolve to the machine itself whatever DNS says. */
export function isBlockedHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/\.$/, "");
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa")) return true;
  if (h === "metadata.google.internal" || h === "metadata") return true;
  return false;
}

/**
 * Checks one URL: scheme, host name, and where the host actually resolves.
 * Throws UnsafeUrlError with a reason a user can read.
 */
export async function assertSafeUrl(raw: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new UnsafeUrlError("That is not a valid URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UnsafeUrlError(`Only http and https addresses can be fetched (got ${url.protocol}).`);
  }
  if (url.username || url.password) {
    throw new UnsafeUrlError("Addresses carrying credentials are not fetched.");
  }

  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!host || isBlockedHost(host)) {
    throw new UnsafeUrlError("Addresses on this machine or its local network are not fetched.");
  }

  if (net.isIP(host)) {
    if (isPrivateAddress(host)) {
      throw new UnsafeUrlError("Addresses on this machine or its local network are not fetched.");
    }
    return url;
  }

  let addresses: { address: string }[];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch {
    throw new UnsafeUrlError(`Could not resolve ${host}.`);
  }
  if (!addresses.length) throw new UnsafeUrlError(`Could not resolve ${host}.`);
  // One private answer is enough to refuse: a name that resolves to both a
  // public and a private address is exactly what a rebinding attack looks like.
  if (addresses.some((a) => isPrivateAddress(a.address))) {
    throw new UnsafeUrlError(`${host} resolves to a local address and is not fetched.`);
  }
  return url;
}

/**
 * `fetch` for addresses that did not come from this code: validated first,
 * redirects followed by hand and validated again at every hop.
 */
export async function safeFetch(input: string, init: RequestInit = {}): Promise<Response> {
  let current = (await assertSafeUrl(input)).toString();

  for (let hop = 0; ; hop++) {
    const res = await fetch(current, { ...init, redirect: "manual" });
    const status = res.status;
    if (status < 300 || status > 399) return res;

    const location = res.headers.get("location");
    if (!location) return res;
    if (hop >= MAX_REDIRECTS) {
      throw new UnsafeUrlError(`Too many redirects (more than ${MAX_REDIRECTS}).`);
    }
    // Drain the body so the connection can be reused before the next hop.
    await res.arrayBuffer().catch(() => undefined);

    const next = (await assertSafeUrl(new URL(location, current).toString())).toString();
    // A 303, or a 301/302 answering a POST, is re-requested as a GET.
    if (status === 303 || ((status === 301 || status === 302) && init.method && init.method !== "GET")) {
      init = { ...init, method: "GET", body: undefined };
    }
    current = next;
  }
}
