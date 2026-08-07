import { timingSafeEqual } from "node:crypto";

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

  const actual = Buffer.from(token, "utf8");
  const expected = Buffer.from(expectedToken, "utf8");
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
