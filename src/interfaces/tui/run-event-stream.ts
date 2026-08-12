import { M1_EVENT_TYPES, type RunEventType } from "../../domain/events.js";
import type { JsonValue } from "../../domain/json.js";
import type { CliClient } from "../cli/client.js";

const RUN_EVENT_TYPES = new Set<string>(M1_EVENT_TYPES);
const TERMINAL_RUN_EVENTS = new Set<RunEventType>([
  "run.completed",
  "run.failed",
  "run.cancelled",
]);

export interface RunEventCursor {
  readonly runId: string;
  readonly lastEventId?: string;
}

export interface SafeRunEvent {
  readonly runId: string;
  readonly sequence: number;
  readonly type: RunEventType;
  readonly occurredAt: string;
  readonly payload: JsonValue;
}

interface RunEventClient {
  stream(path: string, lastEventId?: string, signal?: AbortSignal): Promise<Response>;
}

export class RunEventStreamError extends Error {
  readonly traceId = "tui";

  constructor(
    readonly code: "invalid_run_event" | "run_event_stream_failed",
    readonly detail: string,
    readonly cursor: RunEventCursor,
  ) {
    super(code);
  }
}

export async function consumeRunEvents(input: {
  readonly client: RunEventClient | Pick<CliClient, "stream">;
  readonly cursor: RunEventCursor;
  readonly onEvent: (event: SafeRunEvent) => void;
  readonly signal: AbortSignal;
}): Promise<RunEventCursor> {
  let committed = input.cursor;
  if (input.signal.aborted) return committed;

  let response: Response;
  try {
    response = await input.client.stream(
      `/v1/runs/${encodeURIComponent(input.cursor.runId)}/events`,
      input.cursor.lastEventId,
      input.signal,
    );
  } catch {
    return committed;
  }
  if (!response.ok || response.body === null) {
    throw new RunEventStreamError(
      "run_event_stream_failed",
      "The committed Run event stream is unavailable.",
      committed,
    );
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let frame: string[] = [];
  try {
    for (;;) {
      let chunk: Awaited<ReturnType<typeof reader.read>>;
      try {
        chunk = await reader.read();
      } catch {
        return committed;
      }
      if (chunk.done) return committed;
      buffer += decoder.decode(chunk.value, { stream: true });

      for (;;) {
        const lineBreak = buffer.indexOf("\n");
        if (lineBreak < 0) break;
        const rawLine = buffer.slice(0, lineBreak);
        buffer = buffer.slice(lineBreak + 1);
        const line = rawLine.endsWith("\r") ? rawLine.slice(0, -1) : rawLine;
        if (line.length > 0) {
          frame.push(line);
          continue;
        }
        const event = decodeFrame(frame, input.cursor.runId, committed);
        frame = [];
        if (event === undefined) continue;
        input.onEvent(event);
        committed = greatestCursor(committed, event.sequence);
        if (TERMINAL_RUN_EVENTS.has(event.type)) {
          await reader.cancel().catch(() => undefined);
          return committed;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function decodeFrame(
  lines: readonly string[],
  expectedRunId: string,
  cursor: RunEventCursor,
): SafeRunEvent | undefined {
  let id: string | undefined;
  let eventName: string | undefined;
  const dataLines: string[] = [];
  for (const line of lines) {
    if (line.startsWith(":")) continue;
    const separator = line.indexOf(":");
    const field = separator < 0 ? line : line.slice(0, separator);
    const rawValue = separator < 0 ? "" : line.slice(separator + 1);
    const value = rawValue.startsWith(" ") ? rawValue.slice(1) : rawValue;
    if (field === "id") id = value;
    if (field === "event") eventName = value;
    if (field === "data") dataLines.push(value);
  }
  if (id === undefined && eventName === undefined && dataLines.length === 0) return undefined;
  if (id === undefined || eventName === undefined || dataLines.length === 0) {
    throw invalidEvent(cursor);
  }

  const sequence = parseEventId(id, cursor);
  let decoded: unknown;
  try {
    decoded = JSON.parse(dataLines.join("\n")) as unknown;
  } catch {
    throw invalidEvent(cursor);
  }
  if (!isSafeRunEvent(decoded) ||
      decoded.runId !== expectedRunId ||
      decoded.sequence !== sequence ||
      decoded.type !== eventName) {
    throw invalidEvent(cursor);
  }
  return decoded;
}

function parseEventId(id: string, cursor: RunEventCursor): number {
  if (!/^(0|[1-9][0-9]*)$/u.test(id)) throw invalidEvent(cursor);
  const parsed = Number(id);
  if (!Number.isSafeInteger(parsed)) throw invalidEvent(cursor);
  return parsed;
}

function isSafeRunEvent(value: unknown): value is SafeRunEvent {
  if (!isRecord(value)) return false;
  const keys = Object.keys(value);
  return keys.length === 5 &&
    keys.every((key) => ["runId", "sequence", "type", "occurredAt", "payload"].includes(key)) &&
    typeof value.runId === "string" &&
    Number.isSafeInteger(value.sequence) &&
    typeof value.type === "string" &&
    RUN_EVENT_TYPES.has(value.type) &&
    typeof value.occurredAt === "string" &&
    Number.isFinite(Date.parse(value.occurredAt)) &&
    isJsonValue(value.payload);
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every(isJsonValue);
  return isRecord(value) && Object.values(value).every(isJsonValue);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function greatestCursor(cursor: RunEventCursor, sequence: number): RunEventCursor {
  const current = cursor.lastEventId === undefined ? -1 : Number(cursor.lastEventId);
  if (Number.isSafeInteger(current) && current >= sequence) return cursor;
  return { runId: cursor.runId, lastEventId: String(sequence) };
}

function invalidEvent(cursor: RunEventCursor): RunEventStreamError {
  return new RunEventStreamError(
    "invalid_run_event",
    "The committed Run event is invalid.",
    cursor,
  );
}
