import { once } from "node:events";
import type { ServerResponse } from "node:http";

import type { FastifyRequest } from "fastify";

import type { RunStore } from "../../ports/run-store.js";
import type { RunId } from "../../domain/ids.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export async function streamRunEvents(
  request: FastifyRequest,
  response: ServerResponse,
  runId: RunId,
  runs: Pick<RunStore, "getRun" | "listEventsAfter">,
): Promise<void> {
  const raw = response;
  let cursor = parseLastEventId(request.headers["last-event-id"]);
  let closed = false;
  raw.once("close", () => { closed = true; });
  const write = async (value: string): Promise<void> => {
    if (!raw.write(value)) await once(raw, "drain");
  };
  const heartbeat = setInterval(() => { if (!closed && !raw.writableEnded) raw.write(": heartbeat\n\n"); }, 15_000);
  try {
    while (!closed && !raw.writableEnded) {
      const events = runs.listEventsAfter(runId, cursor);
      for (const event of events) {
        await write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: event.runId, sequence: event.sequence, type: event.type, occurredAt: event.occurredAt.toISOString(), payload: event.payload })}\n\n`);
        cursor = event.sequence;
      }
      if (TERMINAL.has(runs.getRun(runId).state)) break;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  } finally {
    clearInterval(heartbeat);
    if (!raw.writableEnded) raw.end();
  }
}

export function parseLastEventId(value: string | string[] | undefined): number {
  if (value === undefined) return 0;
  if (Array.isArray(value) || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid_last_event_id");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid_last_event_id");
  return parsed;
}
