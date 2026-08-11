import { timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";

export function isAuthorized(
  authorization: string | undefined,
  expectedToken: string,
): boolean {
  if (authorization === undefined || !authorization.startsWith("Bearer ")) {
    return false;
  }

  const token = authorization.slice("Bearer ".length);
  if (token.length === 0 || /\s/.test(token)) {
    return false;
  }

  return tokensEqual(token, expectedToken);
}

export function tokensEqual(actualToken: string, expectedToken: string): boolean {
  const actual = Buffer.from(actualToken, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function isLoopbackPeer(remoteAddress: string | undefined): boolean {
  if (remoteAddress === undefined) return false;
  const normalized = normalizeMappedIpv4(remoteAddress);
  return normalized === "::1" ||
    (isIP(normalized) === 4 && normalized.split(".", 1)[0] === "127");
}

function normalizeMappedIpv4(remoteAddress: string): string {
  const lower = remoteAddress.toLowerCase();
  if (!lower.startsWith("::ffff:")) return lower;
  const dotted = lower.slice("::ffff:".length);
  if (isIP(dotted) === 4) return dotted;
  const hexadecimal = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(lower);
  if (hexadecimal === null || isIP(lower) !== 6) return lower;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}
