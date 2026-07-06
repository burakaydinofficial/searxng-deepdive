// SSRF guard for web_url_read.
//
// web_url_read fetches a URL chosen by the LLM, and the LLM's choice can be
// steered by attacker-controlled content (a poisoned search snippet, or a page
// it read earlier). Without a destination check that makes it a read-SSRF
// gadget: it can reach loopback, RFC1918, link-local cloud-metadata
// (169.254.169.254) and internal Docker services (SearXNG, Valkey, Traefik),
// then hand the response body straight back into the model context.
//
// Policy: block by default any URL whose host is — or resolves to — a
// private/internal address, on the initial request AND every redirect hop.
// Operators can opt specific hosts back in via SEARXNG_DEEPDIVE_ALLOWED_HOSTS
// (comma-separated hostnames and/or IPs).
//
// Scope: this guard is deliberately applied to web_url_read only. The SearXNG
// client (searxng.ts) talks to an operator-configured SEARXNG_URL that is not
// LLM-controlled and is frequently a loopback address on purpose — guarding it
// would break the server.

import { Agent } from "undici";
import { lookup as dnsLookupCb } from "node:dns";
import { isIP, type LookupFunction } from "node:net";
import { promisify } from "node:util";

const dnsLookup = promisify(dnsLookupCb);

export const ALLOWLIST_ENV = "SEARXNG_DEEPDIVE_ALLOWED_HOSTS";

// Blocking private/internal HTTP destinations is OPT-IN. web_url_read reaching
// intranet and IP-based endpoints is a documented feature of this local
// research tool (see README "Security notes" and SECURITY.md) — it is NOT an
// SSRF vulnerability in the intended local-first, user-controlled-LLM
// deployment. Operators who run in a less-trusted topology can set this env to
// turn the guard on. Unset (default): web_url_read fetches any http(s) URL.
// (This never affects `file://` or other non-http(s) schemes, which the scheme
// check rejects regardless, so local file reads stay disabled.)
export const BLOCK_PRIVATE_ENV = "SEARXNG_DEEPDIVE_BLOCK_PRIVATE";

export function isPrivateBlockingEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const v = (env[BLOCK_PRIVATE_ENV] ?? "").trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

export class BlockedAddressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedAddressError";
  }
}

// IPv4 literal → blocked if loopback / private / link-local / CGNAT /
// unspecified / multicast / reserved.
function isBlockedV4(ip: string): boolean {
  const parts = ip.split(".");
  if (parts.length !== 4) return false;
  const o = parts.map((p) => Number(p));
  if (o.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = o as [number, number, number, number];
  if (a === 0) return true; // 0.0.0.0/8 "this host"
  if (a === 10) return true; // 10.0.0.0/8 private
  if (a === 127) return true; // 127.0.0.0/8 loopback
  if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local (incl. cloud metadata)
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
  if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
  if (a === 192 && b === 0 && o[2] === 0) return true; // 192.0.0.0/24 IETF protocol assignments
  if (a >= 224) return true; // 224.0.0.0/4 multicast + 240.0.0.0/4 reserved + 255.255.255.255
  return false;
}

// Expand an IPv6 literal — any textual form (compressed "::", fully expanded,
// or with an embedded IPv4 dotted tail) — into its 8 16-bit groups. Returns
// null if it is not a well-formed IPv6 literal. Expanding first means the range
// checks below are independent of textual form (no regex-per-shape gaps).
function expandIPv6(input: string): number[] | null {
  let s = input.toLowerCase();
  const zone = s.indexOf("%");
  if (zone >= 0) s = s.slice(0, zone);

  // Fold an embedded IPv4 tail (e.g. ::ffff:1.2.3.4) into two hex groups.
  const v4tail = /^(.*:)(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(s);
  if (v4tail) {
    const o = [v4tail[2]!, v4tail[3]!, v4tail[4]!, v4tail[5]!].map(Number);
    if (o.some((n) => n > 255)) return null;
    const g6 = ((o[0]! << 8) | o[1]!).toString(16);
    const g7 = ((o[2]! << 8) | o[3]!).toString(16);
    s = `${v4tail[1]}${g6}:${g7}`;
  }

  const halves = s.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail =
    halves.length === 2 ? (halves[1] ? halves[1]!.split(":") : []) : [];

  let groups: string[];
  if (halves.length === 2) {
    const missing = 8 - head.length - tail.length;
    if (missing < 0) return null;
    groups = [...head, ...Array<string>(missing).fill("0"), ...tail];
  } else {
    groups = head;
  }
  if (groups.length !== 8) return null;

  const nums = groups.map((g) => (g === "" ? 0 : parseInt(g, 16)));
  if (nums.some((n) => !Number.isInteger(n) || n < 0 || n > 0xffff)) return null;
  return nums;
}

// Read the low 32 bits of a v6 address as an embedded IPv4 quad and test it.
function embeddedV4Blocked(hi: number, lo: number): boolean {
  return isBlockedV4(
    `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`,
  );
}

// IPv6 literal → blocked if loopback / unspecified / ULA / link-local /
// multicast, or an IPv4-mapped / -compatible / NAT64-embedded address whose
// embedded v4 is blocked.
function isBlockedV6(ip: string): boolean {
  const g = expandIPv6(ip);
  if (!g) return false;
  if (g.every((x) => x === 0)) return true; // :: unspecified
  if (
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 &&
    g[4] === 0 && g[5] === 0 && g[6] === 0 && g[7] === 1
  )
    return true; // ::1 loopback
  if ((g[0]! & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  if ((g[0]! & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((g[0]! & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  const embedsV4 =
    g[0] === 0 && g[1] === 0 && g[2] === 0 && g[3] === 0 && g[4] === 0;
  // ::ffff:0:0/96 IPv4-mapped, ::/96 IPv4-compatible (deprecated) — both put an
  // embedded v4 in the low 32 bits.
  if (embedsV4 && (g[5] === 0xffff || g[5] === 0))
    return embeddedV4Blocked(g[6]!, g[7]!);
  // NAT64 well-known prefix 64:ff9b::/96.
  if (g[0] === 0x0064 && g[1] === 0xff9b && g[2] === 0 && g[3] === 0 && g[4] === 0 && g[5] === 0)
    return embeddedV4Blocked(g[6]!, g[7]!);
  return false;
}

// True if `ip` is an IP literal in a private/internal range. Returns false for
// anything that is not an IP literal — hostnames are resolved by the caller.
export function isBlockedAddress(ip: string): boolean {
  const fam = isIP(ip);
  if (fam === 4) return isBlockedV4(ip);
  if (fam === 6) return isBlockedV6(ip);
  return false;
}

// Parse the operator allowlist from the environment (comma-separated, lowercased).
export function getAllowlist(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const set = new Set<string>();
  for (const entry of (env[ALLOWLIST_ENV] ?? "").split(",")) {
    const h = entry.trim().toLowerCase();
    if (h) set.add(h);
  }
  return set;
}

// URL.hostname wraps IPv6 in brackets ("[::1]"); strip them for comparison.
function normalizeHost(hostname: string): string {
  const h = hostname.toLowerCase();
  return h.startsWith("[") && h.endsWith("]") ? h.slice(1, -1) : h;
}

// Throw BlockedAddressError if `url`'s host is — or resolves to — a
// private/internal address, unless it is on the operator allowlist.
//
// Tolerant of DNS failure by design: a host that cannot be resolved cannot be
// connected to, so rather than blocking we let undici surface the natural
// connection error. We only actively block when we can prove the destination
// is internal.
export async function assertUrlAllowed(
  url: string,
  env: NodeJS.ProcessEnv = process.env,
): Promise<void> {
  const host = normalizeHost(new URL(url).hostname);
  const allowlist = getAllowlist(env);
  if (allowlist.has(host)) return;

  // Literal IP: decide directly (covers IPv4/IPv6 literals, incl. bracketed v6).
  if (isIP(host)) {
    if (isBlockedAddress(host)) {
      throw new BlockedAddressError(
        `Refusing to fetch ${url}: ${host} is a private/internal address. ` +
          `web_url_read only reaches public hosts; set ${ALLOWLIST_ENV} to allow specific internal hosts.`,
      );
    }
    return;
  }

  // Hostname: resolve and reject if ANY resolved address is internal. Resolving
  // here also collapses alternate encodings (decimal/octal/hex "IP" hostnames)
  // to a canonical address.
  //
  // NOTE: this pre-flight resolution is a fast first line of defense and gives
  // clear errors, but it does NOT by itself close DNS rebinding — undici would
  // resolve again at connect time, and an attacker's authoritative DNS can
  // answer the two lookups differently. The authoritative, rebinding-safe check
  // is the connect-time guard from createGuardedAgent(), which vets the exact
  // address undici dials. Both layers run; keep them.
  let addrs: { address: string; family: number }[];
  try {
    addrs = await dnsLookup(host, { all: true });
  } catch {
    return; // unresolvable → unreachable → let the fetch fail naturally
  }
  for (const a of addrs) {
    if (allowlist.has(a.address)) continue;
    if (isBlockedAddress(a.address)) {
      throw new BlockedAddressError(
        `Refusing to fetch ${url}: host "${host}" resolves to private/internal address ${a.address}. ` +
          `Set ${ALLOWLIST_ENV} to allow specific internal hosts.`,
      );
    }
  }
}

// A drop-in net/tls `lookup` that resolves via the system resolver and refuses
// to hand back a private/internal address (honoring `allowlist`). Because
// undici connects to exactly the address this returns, the address that is
// checked IS the address that is dialed — which is what closes the
// check-then-connect DNS-rebinding gap that a separate pre-flight resolution
// cannot. Delegates to node:dns lookup with the caller's options so it honors
// the { all } contract net/undici expect. The internal casts bridge dns.lookup's
// overloaded signatures (address is a string, or an array when options.all set).
export function makeGuardedLookup(allowlist: Set<string>): LookupFunction {
  const lookupAny = dnsLookupCb as unknown as (
    hostname: string,
    options: unknown,
    cb: (err: NodeJS.ErrnoException | null, address: unknown, family: number) => void,
  ) => void;

  return ((
    hostname: string,
    options: unknown,
    callback: (
      err: NodeJS.ErrnoException | null,
      address?: unknown,
      family?: number,
    ) => void,
  ) => {
    lookupAny(hostname, options, (err, address, family) => {
      if (err) return callback(err, address, family);
      const hostLc = hostname.toLowerCase();
      const list = Array.isArray(address)
        ? (address as { address: string; family: number }[])
        : [{ address: address as string, family }];
      if (!allowlist.has(hostLc)) {
        for (const a of list) {
          if (!allowlist.has(a.address) && isBlockedAddress(a.address)) {
            return callback(
              new BlockedAddressError(
                `Refusing to connect to "${hostname}": it resolves to private/internal address ${a.address}. ` +
                  `Set ${ALLOWLIST_ENV} to allow specific internal hosts.`,
              ),
            );
          }
        }
      }
      callback(null, address, family);
    });
  }) as unknown as LookupFunction;
}

// An undici Agent whose connections refuse private/internal destinations at
// connect time (rebinding-safe). `alwaysAllow` hosts (e.g. the operator's
// configured SEARXNG_URL host) plus the SEARXNG_DEEPDIVE_ALLOWED_HOSTS env
// allowlist bypass the block. Install with undici's setGlobalDispatcher.
export function createGuardedAgent(
  alwaysAllow: string[] = [],
  env: NodeJS.ProcessEnv = process.env,
): Agent {
  const allow = getAllowlist(env);
  // normalizeHost strips IPv6 brackets so the entry matches the de-bracketed
  // hostname undici hands the guarded lookup (URL.hostname yields "[::1]").
  for (const h of alwaysAllow) allow.add(normalizeHost(h));
  return new Agent({ connect: { lookup: makeGuardedLookup(allow) } });
}
