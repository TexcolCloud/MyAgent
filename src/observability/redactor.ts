const REDACTED = "[REDACTED]";
const TRUNCATED = "[TRUNCATED]";
const CIRCULAR = "[CIRCULAR]";
const UNAVAILABLE = "[UNAVAILABLE]";

const DEFAULT_SENSITIVE_KEYS = [
  "authorization",
  "cookie",
  "apikey",
  "token",
  "secret",
] as const;

export interface RedactionPolicy {
  readonly secretValues: readonly string[];
  readonly sensitiveKeys: ReadonlySet<string>;
  readonly maxDepth: number;
  readonly maxCollectionEntries: number;
  readonly maxStringLength: number;
}

export interface RedactionOptions {
  sensitiveKeys?: readonly string[];
  maxDepth?: number;
  maxCollectionEntries?: number;
  maxStringLength?: number;
}

export function secrets(
  values: readonly string[],
  options: RedactionOptions = {},
): RedactionPolicy {
  const secretValues = [...new Set(values.filter((value) => value.length > 0))]
    .sort((left, right) => right.length - left.length);
  const sensitiveKeys = new Set([
    ...DEFAULT_SENSITIVE_KEYS,
    ...(options.sensitiveKeys ?? []).map((key) => key.toLowerCase()),
  ]);
  return Object.freeze({
    secretValues: Object.freeze(secretValues),
    sensitiveKeys,
    maxDepth: positiveInteger(options.maxDepth, 8),
    maxCollectionEntries: positiveInteger(options.maxCollectionEntries, 100),
    maxStringLength: positiveInteger(options.maxStringLength, 16_384),
  });
}

export function redact(value: unknown, policy: RedactionPolicy): unknown {
  return redactValue(value, policy, 0, new WeakSet<object>());
}

function redactValue(
  value: unknown,
  policy: RedactionPolicy,
  depth: number,
  active: WeakSet<object>,
): unknown {
  if (typeof value === "string") return redactString(value, policy);
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") {
    return redactString(String(value), policy);
  }
  if (value === undefined) return "[UNDEFINED]";
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return redactError(value, policy, depth, active);
  if (depth >= policy.maxDepth) return TRUNCATED;
  if (active.has(value)) return CIRCULAR;

  active.add(value);
  try {
    if (Array.isArray(value)) {
      const output = value
        .slice(0, policy.maxCollectionEntries)
        .map((entry) => redactValue(entry, policy, depth + 1, active));
      if (value.length > policy.maxCollectionEntries) output.push(TRUNCATED);
      return output;
    }
    return redactObject(value, policy, depth, active);
  } finally {
    active.delete(value);
  }
}

function redactObject(
  value: object,
  policy: RedactionPolicy,
  depth: number,
  active: WeakSet<object>,
): Record<string, unknown> | string {
  const output: Record<string, unknown> = {};
  let entryCount = 0;
  try {
    for (const key in value) {
      if (!Object.prototype.propertyIsEnumerable.call(value, key)) continue;
      if (entryCount >= policy.maxCollectionEntries) {
        output[TRUNCATED] = true;
        break;
      }
      entryCount += 1;
      const redactedKey = redactString(key, policy);
    if (policy.sensitiveKeys.has(key.toLowerCase())) {
        output[redactedKey] = REDACTED;
      continue;
    }
    try {
        output[redactedKey] = redactValue(
        (value as Record<string, unknown>)[key],
        policy,
        depth + 1,
        active,
      );
    } catch {
        output[redactedKey] = UNAVAILABLE;
      }
    }
  } catch {
    return UNAVAILABLE;
  }
  return output;
}

function redactError(
  error: Error,
  policy: RedactionPolicy,
  depth: number,
  active: WeakSet<object>,
): Record<string, unknown> {
  const code = (error as Error & { code?: unknown }).code;
  return {
    name: redactString(error.name, policy),
    message: redactString(error.message, policy),
    ...(code === undefined ? {} : { code: redactValue(code, policy, depth + 1, active) }),
  };
}

function redactString(value: string, policy: RedactionPolicy): string {
  let redacted = value;
  for (const secret of policy.secretValues) {
    redacted = redacted.split(secret).join(REDACTED);
  }
  if (redacted.length <= policy.maxStringLength) return redacted;
  return `${redacted.slice(0, policy.maxStringLength)}${TRUNCATED}`;
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return Number.isSafeInteger(value) && value !== undefined && value > 0 ? value : fallback;
}
