import { randomUUID } from "node:crypto";
import type { CliClient } from "../client.js";
import { writeJson, type CliWrite } from "../formatters.js";

const TERMINAL_RUN_EVENTS = new Set(["run.completed", "run.failed", "run.cancelled"]);

export async function createRun(client: CliClient, input: { agentId: string; sessionKey: string; text: string }, write: CliWrite): Promise<void> {
  writeJson(write, await client.request("/v1/runs", { method: "POST", idempotencyKey: randomUUID(), body: { agentId: input.agentId, sessionKey: input.sessionKey, input: { type: "text", text: input.text } } }));
}
export async function cancelRun(client: CliClient, runId: string, write: CliWrite): Promise<void> { writeJson(write, await client.request(`/v1/runs/${encodeURIComponent(runId)}/cancel`, { method: "POST" })); }
export async function watchRun(client: CliClient, runId: string, write: CliWrite): Promise<void> {
  let cursor: string | undefined;
  for (;;) {
    const response = await client.stream(`/v1/runs/${encodeURIComponent(runId)}/events`, cursor);
    if (!response.ok || response.body === null) throw new Error("run_watch_failed");
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary: number;
      while ((boundary = buffer.indexOf("\n\n")) >= 0) {
        const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
        const id = frame.match(/^id: (.+)$/mu)?.[1]; if (id !== undefined) cursor = id;
        const event = frame.match(/^event: (.+)$/mu)?.[1];
        const data = frame.match(/^data: (.+)$/mu)?.[1]; if (data !== undefined) write(data);
        if (event !== undefined && TERMINAL_RUN_EVENTS.has(event)) {
          await reader.cancel();
          return;
        }
      }
    }
  }
}
