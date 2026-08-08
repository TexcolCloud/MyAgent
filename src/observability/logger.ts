import type { FastifyBaseLogger, FastifyLogFn } from "fastify";

import { redact, secrets, type RedactionPolicy } from "./redactor.js";

const PAYLOAD_KEYS = [
  "modelInput",
  "modelOutput",
  "providerPayload",
  "toolArguments",
  "toolResult",
  "capturedOutput",
  "stdout",
  "stderr",
  "sseData",
  "resolvedEnvironment",
] as const;

export const PRODUCT_TELEMETRY_ENABLED = false;

export interface StructuredLoggerOptions {
  secretValues?: readonly string[];
  sensitiveKeys?: readonly string[];
  write?: (line: string) => void;
  now?: () => Date;
}

interface LoggerSharedState {
  policy: RedactionPolicy;
  write: (line: string) => void;
  now: () => Date;
}

export function createStructuredLogger(
  options: StructuredLoggerOptions = {},
): FastifyBaseLogger {
  const shared: LoggerSharedState = {
    policy: secrets(options.secretValues ?? [], {
      sensitiveKeys: [...PAYLOAD_KEYS, ...(options.sensitiveKeys ?? [])],
    }),
    write: options.write ?? ((line) => { process.stdout.write(`${line}\n`); }),
    now: options.now ?? (() => new Date()),
  };
  return new StructuredLogger(shared, {});
}

class StructuredLogger implements FastifyBaseLogger {
  level = "info";

  readonly info = this.logFunction("info");
  readonly error = this.logFunction("error");
  readonly debug = this.logFunction("debug");
  readonly fatal = this.logFunction("fatal");
  readonly warn = this.logFunction("warn");
  readonly trace = this.logFunction("trace");
  readonly silent = (() => {}) as FastifyLogFn;

  constructor(
    private readonly shared: LoggerSharedState,
    private readonly bindings: Readonly<Record<string, unknown>>,
  ) {}

  child(bindings: Record<string, unknown>): FastifyBaseLogger {
    return new StructuredLogger(this.shared, { ...this.bindings, ...bindings });
  }

  private logFunction(level: string): FastifyLogFn {
    return ((...argumentsList: unknown[]) => {
      try {
        const { fields, message } = normalizeArguments(argumentsList);
        const event = redact({
          ...this.bindings,
          ...fields,
          level,
          time: this.shared.now().toISOString(),
          ...(message === undefined ? {} : { message }),
        }, this.shared.policy);
        this.shared.write(JSON.stringify(event));
      } catch {
        // Logging must not change application control flow.
      }
    }) as FastifyLogFn;
  }
}

function normalizeArguments(argumentsList: readonly unknown[]): {
  fields: Record<string, unknown>;
  message?: string;
} {
  const [first, second] = argumentsList;
  if (typeof first === "string") {
    return { fields: {}, message: first };
  }
  const message = typeof second === "string" ? second : undefined;
  if (first instanceof Error) {
    return { fields: { error: first }, ...(message === undefined ? {} : { message }) };
  }
  if (typeof first === "object" && first !== null && !Array.isArray(first)) {
    return {
      fields: first as Record<string, unknown>,
      ...(message === undefined ? {} : { message }),
    };
  }
  return {
    fields: first === undefined ? {} : { value: first },
    ...(message === undefined ? {} : { message }),
  };
}
