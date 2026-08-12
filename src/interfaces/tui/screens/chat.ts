import { randomUUID } from "node:crypto";

import { truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import {
  consumeRunEvents,
  type RunEventCursor,
  type SafeRunEvent,
} from "../run-event-stream.js";
import { safeDisplayLines } from "../safe-display-text.js";
import type { TuiClient } from "../tui-client.js";
import type { WorkbenchDestination } from "./navigation.js";

type ChatClient = Pick<TuiClient, "createRun" | "stream">;

export interface ChatSubmission {
  readonly agentId: string;
  readonly sessionKey: string;
  readonly text: string;
}

export class ChatScreen implements Component, Focusable {
  focused = false;
  private destination: WorkbenchDestination = "runs";
  private lines: readonly string[] = ["No active Run is selected."];
  private cursor: RunEventCursor | undefined;
  private controller: AbortController | undefined;
  private consuming: Promise<void> | undefined;
  private terminal = false;

  constructor(private readonly options: {
    readonly client?: ChatClient;
    readonly onChange?: () => void;
  } = {}) {}

  show(destination: WorkbenchDestination, lines?: readonly string[]): void {
    this.destination = destination;
    const safe = (lines ?? noSelection(destination)).flatMap(safeDisplayLines);
    this.lines = safe.length === 0 ? noSelection(destination) : safe;
  }

  async submit(input: ChatSubmission): Promise<void> {
    const client = this.requireClient();
    const agentId = required(input.agentId, "Agent ID");
    const sessionKey = required(input.sessionKey, "Session Key");
    const text = required(input.text, "Message");
    if (this.consuming !== undefined) throw new Error("run_stream_active");

    const created = await client.createRun({
      agentId,
      sessionKey,
      text,
      idempotencyKey: randomUUID(),
    });
    this.destination = "runs";
    this.cursor = { runId: created.runId };
    this.terminal = false;
    this.lines = [`Run ${created.runId}`, "Connecting to committed events..."];
    this.changed();
    await this.consume();
  }

  async reconnect(): Promise<boolean> {
    if (this.cursor === undefined || this.terminal || this.consuming !== undefined) return false;
    await this.consume();
    return true;
  }

  cancel(): void {
    this.controller?.abort();
  }

  async settled(): Promise<void> {
    await this.consuming;
  }

  render(width: number): string[] {
    const title = this.destination === "runs" ? "Runs" : titleFor(this.destination);
    return [
      truncateToWidth(title, width),
      ...this.lines.map((line) => truncateToWidth(line, width)),
    ];
  }

  invalidate(): void {}

  private async consume(): Promise<void> {
    const client = this.requireClient();
    const cursor = this.cursor;
    if (cursor === undefined) return;
    const controller = new AbortController();
    this.controller = controller;
    const consuming = consumeRunEvents({
      client,
      cursor,
      signal: controller.signal,
      interruption: "return_cursor",
      onEvent: (event) => this.acceptEvent(event),
    }).then((nextCursor) => {
      this.cursor = nextCursor;
      if (!this.terminal && !controller.signal.aborted) {
        this.lines = [...this.lines, "Reconnect available. Press r."];
      }
    }).catch((error: unknown) => {
      this.lines = [...this.lines, safeProblem(error)];
    }).finally(() => {
      if (this.controller === controller) this.controller = undefined;
      if (this.consuming === consuming) this.consuming = undefined;
      this.changed();
    });
    this.consuming = consuming;
    await consuming;
  }

  private acceptEvent(event: SafeRunEvent): void {
    const safePayload = safeDisplayLines(JSON.stringify(event.payload));
    this.lines = [
      ...this.lines.filter((line) => line !== "Connecting to committed events..." && !line.startsWith("Reconnect available")),
      `${String(event.sequence)} ${event.type}`,
      ...safePayload,
    ];
    this.terminal = ["run.completed", "run.failed", "run.cancelled"].includes(event.type);
    this.changed();
  }

  private requireClient(): ChatClient {
    if (this.options.client === undefined) throw new Error("run_client_unavailable");
    return this.options.client;
  }

  private changed(): void { this.options.onChange?.(); }
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${label} is required.`);
  return normalized;
}

function safeProblem(error: unknown): string {
  if (typeof error === "object" && error !== null) {
    const candidate = error as { code?: unknown; detail?: unknown };
    const code = typeof candidate.code === "string" ? candidate.code : "run_stream_failed";
    const detail = typeof candidate.detail === "string" ? candidate.detail : "The committed Run stream is unavailable.";
    return safeDisplayLines(`${code}: ${detail}`).join(" ");
  }
  return "run_stream_failed: The committed Run stream is unavailable.";
}

function noSelection(destination: WorkbenchDestination): readonly string[] {
  if (destination === "runs") return ["No active Run is selected. Press c to create one."];
  if (destination === "verifications") return ["No Verification is selected."];
  return ["No entries are available."];
}

function titleFor(destination: Exclude<WorkbenchDestination, "runs">): string {
  return destination[0]!.toUpperCase() + destination.slice(1);
}
