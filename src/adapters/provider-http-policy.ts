import type { LookupAddress } from "node:dns";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import type { LookupFunction } from "node:net";

import {
  isAbortError,
  ProviderTimeoutError,
  providerError,
  withDeadline,
} from "./provider-http-response-policy.js";

const AWS_METADATA_IPV6 = [
  0xfd, 0x00, 0x0e, 0xc2, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x02, 0x54,
] as const;

export type ProviderAddressClass =
  | "loopback"
  | "private"
  | "link_local"
  | "metadata"
  | "multicast"
  | "unspecified"
  | "public"
  | "invalid";

export interface ResolvedProviderAddress {
  readonly address: string;
  readonly family: 4 | 6;
}

export type ProviderAddressResolver = (
  hostname: string,
) => Promise<readonly ResolvedProviderAddress[]>;

export function normalizeProviderBaseUrl(value: string): string {
  const url = parseProviderUrl(value);
  const pathname = url.pathname.replace(/\/+$/u, "");
  return `${url.origin}${pathname}`;
}

export function classifyProviderAddress(address: string): ProviderAddressClass {
  if (isIP(address) === 4) return classifyIpv4(address);
  if (isIP(address) !== 6) return "invalid";

  const bytes = ipv6Bytes(address);
  if (bytes === undefined) return "invalid";
  if (
    bytes.slice(0, 10).every((value) => value === 0) &&
    bytes[10] === 0xff &&
    bytes[11] === 0xff
  ) {
    return classifyIpv4(bytes.slice(12).join("."));
  }
  if (bytes.every((value, index) => value === AWS_METADATA_IPV6[index])) {
    return "metadata";
  }
  if (bytes.every((value) => value === 0)) return "unspecified";
  if (
    bytes.slice(0, 15).every((value) => value === 0) &&
    bytes[15] === 1
  ) {
    return "loopback";
  }
  if ((bytes[0] ?? 0) === 0xfe && ((bytes[1] ?? 0) & 0xc0) === 0x80) {
    return "link_local";
  }
  if ((bytes[0] ?? 0) === 0xff) return "multicast";
  if (((bytes[0] ?? 0) & 0xfe) === 0xfc) return "private";
  return "public";
}

export function isProviderAddressAllowed(
  protocol: string,
  classification: ProviderAddressClass,
  allowInsecureHttp: boolean,
): boolean {
  if (
    classification === "invalid" ||
    classification === "link_local" ||
    classification === "metadata" ||
    classification === "multicast" ||
    classification === "unspecified"
  ) {
    return false;
  }
  if (protocol === "https:") return true;
  if (protocol !== "http:") return false;
  if (classification === "loopback") return true;
  return classification === "private" && allowInsecureHttp;
}

export function parseProviderUrl(value: string): URL {
  if (value.trim() !== value) {
    throw providerError("invalid_provider_url", false);
  }
  const schemeSeparator = value.indexOf("://");
  const authorityStart = schemeSeparator < 0 ? 0 : schemeSeparator + 3;
  const authorityEnd = firstDelimiterIndex(value, authorityStart);
  const authority = value.slice(authorityStart, authorityEnd);
  if (value.includes("?") || value.includes("#") || authority.includes("@")) {
    throw providerError("invalid_provider_url", false);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerError("invalid_provider_url", false);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.hostname.length === 0 ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.search.length > 0 ||
    url.hash.length > 0
  ) {
    throw providerError("invalid_provider_url", false);
  }
  return url;
}

export function validateRequestUrl(value: string, baseOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw providerError("invalid_provider_url", false);
  }
  if (
    (url.protocol !== "http:" && url.protocol !== "https:") ||
    url.username.length > 0 ||
    url.password.length > 0 ||
    url.hash.length > 0 ||
    url.origin !== baseOrigin
  ) {
    throw providerError("invalid_provider_url", false);
  }
  return url;
}

export function validateLiteralAddress(url: URL, allowInsecureHttp: boolean): void {
  const hostname = unbracket(url.hostname);
  if (isIP(hostname) === 0) return;
  if (!isProviderAddressAllowed(url.protocol, classifyProviderAddress(hostname), allowInsecureHttp)) {
    throw providerError("insecure_provider_url", false);
  }
}

export async function resolveWithNode(
  hostname: string,
): Promise<readonly ResolvedProviderAddress[]> {
  const results: LookupAddress[] = await lookup(hostname, {
    all: true,
    verbatim: true,
  });
  return results.flatMap((result) =>
    result.family === 4 || result.family === 6
      ? [{ address: result.address, family: result.family }]
      : [],
  );
}

export async function resolveAndValidateProviderAddress(
  resolveAddresses: ProviderAddressResolver,
  url: URL,
  allowInsecureHttp: boolean,
  signal: AbortSignal,
  deadline: number,
): Promise<ResolvedProviderAddress> {
  const hostname = unbracket(url.hostname);
  const literalFamily = isIP(hostname);
  const addresses = literalFamily === 0
    ? await withDeadline(resolveAddresses(hostname), signal, deadline).catch(
        (error: unknown) => {
          if (isAbortError(error)) throw error;
          if (error instanceof ProviderTimeoutError) {
            throw providerError("provider_unavailable", true);
          }
          throw providerError("provider_unavailable", true);
        },
      )
    : [{ address: hostname, family: literalFamily as 4 | 6 }];

  if (addresses.length === 0) {
    throw providerError("provider_unavailable", true);
  }
  for (const address of addresses) {
    const actualFamily = isIP(address.address);
    if (actualFamily === 0 || actualFamily !== address.family) {
      throw providerError("invalid_provider_url", false);
    }
    const classification = classifyProviderAddress(address.address);
    if (!isProviderAddressAllowed(url.protocol, classification, allowInsecureHttp)) {
      throw providerError("insecure_provider_url", false);
    }
  }

  const selected = addresses[0];
  if (selected === undefined) {
    throw providerError("provider_unavailable", true);
  }
  return selected;
}

export function createPinnedLookup(selected: ResolvedProviderAddress): LookupFunction {
  return (_hostname, options, callback): void => {
    if (typeof options === "object" && options.all === true) {
      const allCallback = callback as (
        error: NodeJS.ErrnoException | null,
        addresses: LookupAddress[],
      ) => void;
      allCallback(null, [{ address: selected.address, family: selected.family }]);
      return;
    }
    const oneCallback = callback as (
      error: NodeJS.ErrnoException | null,
      address: string,
      family: number,
    ) => void;
    oneCallback(null, selected.address, selected.family);
  };
}

export function unbracket(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]")
    ? hostname.slice(1, -1)
    : hostname;
}

function firstDelimiterIndex(value: string, start: number): number {
  const indexes = [
    value.indexOf("/", start),
    value.indexOf("?", start),
    value.indexOf("#", start),
  ].filter((index) => index >= 0);
  return indexes.length === 0 ? value.length : Math.min(...indexes);
}

function classifyIpv4(address: string): ProviderAddressClass {
  const parts = address.split(".").map(Number);
  const first = parts[0] ?? -1;
  const second = parts[1] ?? -1;
  if (first === 0) return "unspecified";
  if (first === 127) return "loopback";
  if (first === 10) return "private";
  if (first === 172 && second >= 16 && second <= 31) return "private";
  if (first === 192 && second === 168) return "private";
  if (first === 169 && second === 254) return "link_local";
  if (first >= 224 && first <= 239) return "multicast";
  return "public";
}

function ipv6Bytes(address: string): number[] | undefined {
  const withoutZone = address.split("%", 1)[0];
  if (withoutZone === undefined) return undefined;
  let normalized = withoutZone;
  const ipv4Match = /(?:^|:)(\d+\.\d+\.\d+\.\d+)$/u.exec(normalized);
  if (ipv4Match?.[1] !== undefined) {
    const octets = ipv4Match[1].split(".").map(Number);
    if (octets.length !== 4) return undefined;
    const high = ((octets[0] ?? 0) << 8) | (octets[1] ?? 0);
    const low = ((octets[2] ?? 0) << 8) | (octets[3] ?? 0);
    normalized = normalized.slice(0, -ipv4Match[1].length) +
      `${high.toString(16)}:${low.toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return undefined;
  const left = halves[0]?.length === 0 ? [] : halves[0]?.split(":") ?? [];
  const right = halves.length === 1 || halves[1]?.length === 0
    ? []
    : halves[1]?.split(":") ?? [];
  const omitted = halves.length === 2 ? 8 - left.length - right.length : 0;
  if (omitted < 0 || (halves.length === 1 && left.length !== 8)) return undefined;
  const segments = [
    ...left,
    ...Array.from({ length: omitted }, () => "0"),
    ...right,
  ].map((segment) => Number.parseInt(segment, 16));
  if (segments.length !== 8 || segments.some((segment) => !Number.isFinite(segment))) {
    return undefined;
  }
  return segments.flatMap((segment) => [segment >> 8, segment & 0xff]);
}
