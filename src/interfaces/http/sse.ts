import type { ServerResponse } from "node:http";

import type { FastifyRequest } from "fastify";

import type { RunStore } from "../../ports/run-store.js";
import type { RunId } from "../../domain/ids.js";

const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface SseStreamOptions {
  heartbeatMs?: number;
  pollIntervalMs?: number;
}

export async function streamRunEvents(
  request: FastifyRequest,
  response: ServerResponse,
  runId: RunId,
  runs: Pick<RunStore, "getRun" | "listEventsAfter">,
  options: SseStreamOptions = {},
): Promise<void> {
  const raw = response;
  let cursor = parseLastEventId(request.headers["last-event-id"]);
  let closed = false;
  const heartbeatMs = options.heartbeatMs ?? 15_000;
  const pollIntervalMs = options.pollIntervalMs ?? 100;
  let nextHeartbeatAt = Date.now() + heartbeatMs;
  raw.once("close", () => { closed = true; });
  const write = async (value: string): Promise<void> => {
    if (closed || raw.writableEnded) return;
    if (!raw.write(value)) {
      await waitForDrainOrClose(raw);
    }
  };
  try {
    while (!closed && !raw.writableEnded) {
      const events = runs.listEventsAfter(runId, cursor);
      for (const event of events) {
        await write(`id: ${event.sequence}\nevent: ${event.type}\ndata: ${JSON.stringify({ runId: event.runId, sequence: event.sequence, type: event.type, occurredAt: event.occurredAt.toISOString(), payload: event.payload })}\n\n`);
        cursor = event.sequence;
      }
      if (TERMINAL.has(runs.getRun(runId).state)) break;
      const now = Date.now();
      if (now >= nextHeartbeatAt) {
        await write(": heartbeat\n\n");
        nextHeartbeatAt = Date.now() + heartbeatMs;
      }
      if (!closed) {
        await waitForPollOrClose(
          raw,
          Math.min(pollIntervalMs, Math.max(0, nextHeartbeatAt - Date.now())),
        );
      }
    }
  } finally {
    if (!closed && !raw.writableEnded) raw.end();
  }
}

function waitForDrainOrClose(response: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      response.off("drain", finish);
      response.off("close", finish);
      resolve();
    };
    response.once("drain", finish);
    response.once("close", finish);
  });
}

function waitForPollOrClose(response: ServerResponse, milliseconds: number): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      clearTimeout(timeout);
      response.off("close", finish);
      resolve();
    };
    const timeout = setTimeout(finish, milliseconds);
    response.once("close", finish);
  });
}

export function parseLastEventId(value: string | string[] | undefined): number {
  if (value === undefined) return 0;
  if (Array.isArray(value) || !/^(0|[1-9][0-9]*)$/.test(value)) throw new Error("invalid_last_event_id");
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed)) throw new Error("invalid_last_event_id");
  return parsed;
}
