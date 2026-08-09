import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  NodeProviderHttpTransport,
  classifyProviderAddress,
  isProviderAddressAllowed,
  normalizeProviderBaseUrl,
} from "../../src/adapters/provider-http-transport.js";
import {
  parseProviderConnectionId,
  providerConnectionRevisionIdFromUuid,
} from "../../src/domain/ids.js";
import type { ProviderConnectionRevision } from "../../src/domain/provider-connection.js";

describe("provider network policy", () => {
  it.each([
    "https://user@example.com/v1",
    "https://@example.com/v1",
    "https://example.com/v1?q=x",
    "https://example.com/v1?",
    "https://example.com/v1#x",
    "https://example.com/v1#",
    "http://169.254.169.254/latest",
    "http://0.0.0.0/v1",
    "http://8.8.8.8/v1",
  ])("rejects unsafe provider URL %s", async (baseUrl) => {
    await expect(probe(baseUrl)).rejects.toMatchObject({
      code: expect.stringMatching(/provider_url/),
    });
  });

  it("normalizes trailing slashes without changing the provider path", () => {
    expect(normalizeProviderBaseUrl("https://example.com/v1///")).toBe(
      "https://example.com/v1",
    );
    expect(normalizeProviderBaseUrl("https://example.com/v1/models")).toBe(
      "https://example.com/v1/models",
    );
  });

  it.each([
    ["127.0.0.1", "loopback"],
    ["127.255.1.9", "loopback"],
    ["10.20.30.40", "private"],
    ["172.16.0.1", "private"],
    ["172.31.255.255", "private"],
    ["192.168.1.1", "private"],
    ["169.254.169.254", "link_local"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast"],
    ["0.0.0.0", "unspecified"],
    ["8.8.8.8", "public"],
    ["::1", "loopback"],
    ["fd12:3456:789a::1", "private"],
    ["fd00:ec2::254", "metadata"],
    ["fe80::1", "link_local"],
    ["ff02::1", "multicast"],
    ["::", "unspecified"],
    ["2001:4860:4860::8888", "public"],
    ["::ffff:127.0.0.1", "loopback"],
    ["::ffff:10.0.0.1", "private"],
    ["::ffff:169.254.169.254", "link_local"],
    ["::ffff:224.0.0.1", "multicast"],
    ["::ffff:0.0.0.0", "unspecified"],
    ["::ffff:8.8.8.8", "public"],
  ] as const)("classifies %s as %s", (address, classification) => {
    expect(classifyProviderAddress(address)).toBe(classification);
  });

  it("property-checks IPv4 policy ranges", () => {
    const byte = fc.integer({ min: 0, max: 255 });
    const tail = fc.tuple(byte, byte, byte);
    const privateAddress = fc.oneof(
      fc.tuple(fc.constant(10), byte, byte, byte),
      fc.tuple(fc.constant(172), fc.integer({ min: 16, max: 31 }), byte, byte),
      fc.tuple(fc.constant(192), fc.constant(168), byte, byte),
    );

    fc.assert(
      fc.property(tail, ([second, third, fourth]) => {
        expect(classifyProviderAddress(`127.${second}.${third}.${fourth}`)).toBe(
          "loopback",
        );
      }),
    );
    fc.assert(
      fc.property(privateAddress, (parts) => {
        expect(classifyProviderAddress(parts.join("."))).toBe("private");
      }),
    );
    fc.assert(
      fc.property(tail, ([second, third, fourth]) => {
        expect(classifyProviderAddress(`169.254.${third}.${fourth}`)).toBe(
          "link_local",
        );
        expect(classifyProviderAddress(`0.${second}.${third}.${fourth}`)).toBe(
          "unspecified",
        );
      }),
    );
    fc.assert(
      fc.property(fc.integer({ min: 224, max: 239 }), tail, (first, rest) => {
        expect(classifyProviderAddress([first, ...rest].join("."))).toBe(
          "multicast",
        );
      }),
    );
    fc.assert(
      fc.property(fc.constantFrom(1, 8, 9, 11, 64, 100, 198, 203), tail, (first, rest) => {
        expect(classifyProviderAddress([first, ...rest].join("."))).toBe(
          "public",
        );
      }),
    );
  });

  it("property-checks IPv6 and IPv4-mapped IPv6 ranges", () => {
    const segment = fc.integer({ min: 0, max: 0xffff });
    const ipv4 = fc.tuple(
      fc.integer({ min: 1, max: 223 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 0, max: 255 }),
      fc.integer({ min: 1, max: 254 }),
    );

    fc.assert(
      fc.property(segment, (last) => {
        expect(classifyProviderAddress(`fd00::${last.toString(16)}`)).toBe(
          "private",
        );
        expect(classifyProviderAddress(`fe80::${last.toString(16)}`)).toBe(
          "link_local",
        );
        expect(classifyProviderAddress(`ff02::${last.toString(16)}`)).toBe(
          "multicast",
        );
      }),
    );
    fc.assert(
      fc.property(ipv4, (parts) => {
        const address = parts.join(".");
        expect(classifyProviderAddress(`::ffff:${address}`)).toBe(
          classifyProviderAddress(address),
        );
      }),
    );
  });

  it("permits only the protocol/address combinations authorized by policy", () => {
    expect(isProviderAddressAllowed("https:", "public", false)).toBe(true);
    expect(isProviderAddressAllowed("https:", "private", false)).toBe(true);
    expect(isProviderAddressAllowed("http:", "loopback", false)).toBe(true);
    expect(isProviderAddressAllowed("http:", "private", false)).toBe(false);
    expect(isProviderAddressAllowed("http:", "private", true)).toBe(true);
    expect(isProviderAddressAllowed("http:", "public", true)).toBe(false);
    expect(isProviderAddressAllowed("https:", "link_local", true)).toBe(false);
    expect(isProviderAddressAllowed("https:", "multicast", true)).toBe(false);
    expect(isProviderAddressAllowed("https:", "unspecified", true)).toBe(false);
    expect(isProviderAddressAllowed("https:", "metadata", true)).toBe(false);
  });
});

async function probe(baseUrl: string): Promise<void> {
  const transport = new NodeProviderHttpTransport({
    secretResolver: { resolve: () => "must-not-resolve" },
  });
  const providerFetch = transport.createFetch({
    connection: connection(baseUrl),
    timeoutMs: 25,
    maxResponseBytes: 128,
  });
  await providerFetch(baseUrl);
}

function connection(baseUrl: string): ProviderConnectionRevision {
  return {
    revisionId: providerConnectionRevisionIdFromUuid("00000000-0000-4000-8000-000000000006"),
    connectionId: parseProviderConnectionId("provider"),
    state: "draft",
    baseUrl,
    auth: { type: "none" },
    allowInsecureHttp: false,
    protocolPreference: "responses",
    presetVersion: "test-v1",
    createdAt: new Date(0),
  };
}
