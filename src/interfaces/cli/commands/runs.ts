import { randomUUID } from "node:crypto";
import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";
import { consumeRunEvents } from "../../tui/run-event-stream.js";

export async function createRun(client: CliClient, input: { agentId: string; sessionKey: string; text: string }, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/runs", { method: "POST", idempotencyKey: randomUUID(), body: { agentId: input.agentId, sessionKey: input.sessionKey, input: { type: "text", text: input.text } } }));
}
export async function cancelRun(client: CliClient, runId: string, write: CliWrite): Promise<void> {
  const encodedRunId = encodeURIComponent(runId);
  const run = await client.request<{ updatedAt: string }>(`/v1/runs/${encodedRunId}`);
  writeJson(write, await client.request(`/v1/runs/${encodedRunId}/cancel`, {
    method: "POST",
    body: { confirm: true, expectedRevision: run.updatedAt },
  }));
}
export async function watchRun(client: CliClient, runId: string, write: CliWrite): Promise<void> {
  await consumeRunEvents({
    client,
    cursor: { runId },
    signal: new AbortController().signal,
    onEvent: (_event, serializedData) => { write(serializedData); },
  });
}
