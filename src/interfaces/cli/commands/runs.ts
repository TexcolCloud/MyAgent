import { randomUUID } from "node:crypto";
import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
import { consumeRunEvents } from "../../tui/run-event-stream.js";

const TERMINAL_RUN_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

export async function createRun(client: CliClient, input: { agentId: string; sessionKey: string; text: string }, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/runs", { method: "POST", idempotencyKey: randomUUID(), body: { agentId: input.agentId, sessionKey: input.sessionKey, input: { type: "text", text: input.text } } }));
}
export async function cancelRun(client: CliClient, runId: string, write: CliWrite): Promise<void> { writeJson(write, await client.request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })); }
export async function watchRun(client: CliClient, runId: string, write: CliWrite): Promise<void> {
  let cursor: { readonly runId: string; readonly lastEventId?: string } = { runId };
  let terminal = false;
  const signal = new AbortController().signal;
  for (;;) {
    cursor = await consumeRunEvents({
      client,
      cursor,
      signal,
      onEvent: (event, serializedData) => {
        write(serializedData);
        if (TERMINAL_RUN_EVENTS.has(event.type)) terminal = true;
      },
    });
    if (terminal) return;
  }
}
