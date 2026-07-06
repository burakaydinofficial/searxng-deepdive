// Unit tests for the SSRF guard. isBlockedAddress is pure (no I/O);
// assertUrlAllowed for literal IPs and allowlisted/localhost hosts needs only
// the local resolver, so no network is required.

import { describe, it, expect } from "vitest";
import { request } from "undici";
import {
  isBlockedAddress,
  assertUrlAllowed,
  getAllowlist,
  createGuardedAgent,
  ALLOWLIST_ENV,
  BlockedAddressError,
} from "../src/ssrf-guard.js";

describe("isBlockedAddress — IPv4", () => {
  it("blocks loopback/private/link-local/CGNAT/unspecified/reserved", () => {
    for (const ip of [
      "127.0.0.1",
      "127.1.2.3",
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "169.254.169.254", // cloud metadata
      "0.0.0.0",
      "100.64.0.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public addresses (incl. near-boundary ones)", () => {
    for (const ip of [
      "8.8.8.8",
      "1.1.1.1",
      "93.184.216.34",
      "11.0.0.1",
      "126.0.0.1",
      "128.0.0.1",
      "172.15.0.1", // just below 172.16/12
      "172.32.0.1", // just above 172.16/12
      "192.169.0.1", // just above 192.168/16
      "100.63.0.1", // just below 100.64/10
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("isBlockedAddress — IPv6", () => {
  it("blocks loopback/unspecified/ULA/link-local/multicast and mapped v4", () => {
    for (const ip of [
      "::1",
      "::",
      "fe80::1",
      "fc00::1",
      "fd12:3456:789a::1",
      "ff02::1",
      "::ffff:127.0.0.1",
      "::ffff:169.254.169.254",
      // Uncompressed IPv4-mapped forms (must not depend on "::" compression).
      "0:0:0:0:0:ffff:7f00:1", // == ::ffff:127.0.0.1
      "0:0:0:0:0:ffff:a9fe:a9fe", // == ::ffff:169.254.169.254 (metadata)
      // IPv4-compatible (deprecated) and NAT64 embedded loopback.
      "::7f00:1", // == ::127.0.0.1
      "64:ff9b::7f00:1", // NAT64 -> 127.0.0.1
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(true);
    }
  });

  it("allows public IPv6 (incl. mapped public v4)", () => {
    for (const ip of [
      "2606:4700:4700::1111",
      "2001:4860:4860::8888",
      "::ffff:8.8.8.8",
    ]) {
      expect(isBlockedAddress(ip), ip).toBe(false);
    }
  });
});

describe("isBlockedAddress — non-IP", () => {
  it("returns false for hostnames (resolved elsewhere)", () => {
    expect(isBlockedAddress("example.com")).toBe(false);
    expect(isBlockedAddress("not-an-ip")).toBe(false);
  });
});

describe("getAllowlist", () => {
  it("parses, trims, and lowercases comma-separated entries", () => {
    const set = getAllowlist({ [ALLOWLIST_ENV]: " 127.0.0.1 , LocalHost ,, myservice.internal " });
    expect([...set].sort()).toEqual(["127.0.0.1", "localhost", "myservice.internal"]);
  });

  it("returns an empty set when unset", () => {
    expect(getAllowlist({}).size).toBe(0);
  });
});

describe("assertUrlAllowed", () => {
  it("blocks a literal loopback URL", async () => {
    await expect(
      assertUrlAllowed("http://127.0.0.1:7979/config", {}),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks a bracketed IPv6 loopback URL", async () => {
    await expect(
      assertUrlAllowed("http://[::1]:8080/", {}),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("blocks the cloud-metadata address", async () => {
    await expect(
      assertUrlAllowed("http://169.254.169.254/latest/meta-data/", {}),
    ).rejects.toThrow(/private\/internal/);
  });

  it("blocks localhost (resolves to loopback)", async () => {
    await expect(
      assertUrlAllowed("http://localhost:7979/", {}),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });

  it("allows a public literal IP", async () => {
    await expect(assertUrlAllowed("http://8.8.8.8/", {})).resolves.toBeUndefined();
  });

  it("is tolerant of unresolvable hosts (unreachable, so not blocked here)", async () => {
    await expect(
      assertUrlAllowed("http://does-not-exist.invalid/", {}),
    ).resolves.toBeUndefined();
  });

  it("honors the allowlist for an internal IP", async () => {
    await expect(
      assertUrlAllowed("http://127.0.0.1:7979/config", { [ALLOWLIST_ENV]: "127.0.0.1" }),
    ).resolves.toBeUndefined();
  });

  it("honors the allowlist by hostname", async () => {
    await expect(
      assertUrlAllowed("http://localhost:7979/", { [ALLOWLIST_ENV]: "localhost" }),
    ).resolves.toBeUndefined();
  });

  it("pre-flight uses only the env allowlist — the connect-guard's SEARXNG-host allowance does not weaken it", async () => {
    // createGuardedAgent may allowlist the operator's SEARXNG host so the
    // metasearch client works, but web_url_read's pre-flight (this function)
    // reads only SEARXNG_DEEPDIVE_ALLOWED_HOSTS, so a steered web_url_read to
    // that same internal host is still blocked. Pin that invariant.
    await expect(
      assertUrlAllowed("http://127.0.0.1:8080/", {}),
    ).rejects.toBeInstanceOf(BlockedAddressError);
  });
});

// The connect-time guard is the rebinding-safe layer: it vets the exact address
// undici dials. We can't stage a real rebinding race in a unit test, but we can
// prove the guard refuses a hostname that resolves to an internal address AT
// CONNECT TIME (which is the mechanism that closes rebinding), and that an
// allowlisted host bypasses it.
describe("createGuardedAgent (connect-time guard)", () => {
  it("refuses to connect to a hostname that resolves to loopback", async () => {
    const agent = createGuardedAgent([], {});
    await expect(
      request("http://localhost:9/", { dispatcher: agent }),
    ).rejects.toThrow(/private\/internal/);
    await agent.close();
  });

  it("allows an alwaysAllow host through the connect guard", async () => {
    // localhost is allowed, so the guard must NOT be what fails the request —
    // the connection still fails (nothing listens on :9) but not as a block.
    const agent = createGuardedAgent(["localhost"], {});
    await expect(
      request("http://localhost:9/", { dispatcher: agent }),
    ).rejects.not.toThrow(/private\/internal/);
    await agent.close();
  });
});
