import type { AgentResolverPort } from "../domain/agent-revision.js";
import type { RunId, SessionId } from "../domain/ids.js";
import {
  parseAgentId,
  parseIdempotencyKey,
  parseSessionKey,
} from "../domain/ids.js";
import type { Clock } from "../ports/clock.js";
import type { IdGenerator } from "../ports/id-generator.js";
import type { RunStore } from "../ports/run-store.js";

export interface CreateRunCommand {
  agentId: string;
  sessionKey: string;
  input: { type: "text"; text: string };
  idempotencyKey: string;
  source: { kind: "http"; externalId?: string };
}

export interface CreateRunResult {
  runId: RunId;
  sessionId: SessionId;
  state: "queued";
  created: boolean;
}

export class CreateRunService {
  constructor(
    private readonly agents: Pick<AgentResolverPort, "resolve">,
    private readonly runs: RunStore,
    private readonly clock: Clock,
    private readonly ids: IdGenerator,
  ) {}

  execute(command: CreateRunCommand): CreateRunResult {
    assertTextInput(command.input);
    assertHttpSource(command.source);
    const agentId = parseAgentId(command.agentId);
    const sessionKey = parseSessionKey(command.sessionKey);
    const idempotencyKey = parseIdempotencyKey(command.idempotencyKey);
    const result = this.runs.create({
      agentId,
      sessionKey,
      idempotencyKey,
      input: command.input,
      source: command.source,
      resolveRevision: () => this.agents.resolve(agentId),
      occurredAt: this.clock.now(),
      allocateSessionId: () => this.ids.sessionId(),
      allocateRunId: () => this.ids.runId(),
    });

    return {
      runId: result.run.runId,
      sessionId: result.run.sessionId,
      state: "queued",
      created: result.created,
    };
  }
}

function assertTextInput(input: CreateRunCommand["input"]): void {
  if (input.type !== "text" || typeof input.text !== "string") {
    throw new Error("invalid_run_input");
  }
}

function assertHttpSource(source: CreateRunCommand["source"]): void {
  if (
    source.kind !== "http" ||
    (source.externalId !== undefined && typeof source.externalId !== "string")
  ) {
    throw new Error("invalid_run_source");
  }
}
