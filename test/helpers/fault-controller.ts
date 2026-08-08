import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { bootstrap, type BootstrappedService } from "../../src/bootstrap.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { FaultPoint } from "../../src/runtime/fault-injector.js";

const EXAMPLES = fileURLToPath(new URL("../../examples", import.meta.url));
const BEARER_TOKEN = "e2e-operator-secret";
const MODEL_SECRET = "e2e-provider-secret";

export type ProviderTurn =
  | { type: "tool"; name: string; arguments: JsonValue }
  | { type: "text"; text: string };

export interface CapturedProviderRequest {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
}

export class ScriptedChatServer {
  readonly requests: CapturedProviderRequest[] = [];
  readonly baseUrl: string;

  private constructor(
    private readonly server: Server,
    private readonly turns: ProviderTurn[],
    port: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${String(port)}/v1`;
  }

  static async start(turns: readonly ProviderTurn[]): Promise<ScriptedChatServer> {
    const reference: { scripted?: ScriptedChatServer } = {};
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        if (reference.scripted === undefined) {
          response.writeHead(500).end();
          return;
        }
        reference.scripted.respond(Buffer.concat(chunks), response);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as AddressInfo;
    const scripted = new ScriptedChatServer(server, [...turns], address.port);
    reference.scripted = scripted;
    return scripted;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      this.server.close((error) => error === undefined ? resolve() : reject(error));
    });
  }

  private respond(body: Buffer, response: ServerResponse): void {
    const request = JSON.parse(body.toString("utf8")) as CapturedProviderRequest;
    this.requests.push(request);
    const turn = this.turns.shift();
    if (turn === undefined) {
      response.writeHead(500, { "content-type": "application/json" });
      response.end(JSON.stringify({ error: { code: "scripted_turn_missing" } }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    const events = turn.type === "text"
      ? [frame({ content: turn.text }), frame({}, "stop"), usageFrame()]
      : [
          frame({
            tool_calls: [{
              index: 0,
              id: `call-${String(this.requests.length)}`,
              type: "function",
              function: { name: turn.name, arguments: JSON.stringify(turn.arguments) },
            }],
          }),
          frame({}, "tool_calls"),
          usageFrame(),
        ];
    for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`);
    response.end("data: [DONE]\n\n");
  }
}

export interface E2eFixture {
  root: string;
  configPath: string;
  databasePath: string;
  primaryWorkspace: string;
  researcherWorkspace: string;
  cleanup(): Promise<void>;
}

export async function prepareE2eFixture(
  baseUrl: string,
  options: { allowRunCommand?: boolean } = {},
): Promise<E2eFixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-e2e-"));
  const configRoot = path.join(root, "config");
  await cp(EXAMPLES, configRoot, { recursive: true });
  const configPath = path.join(configRoot, "myagent.yaml");
  const databasePath = path.join(configRoot, "data", "kernel.db");
  const primaryWorkspace = path.join(configRoot, "agents", "primary", "workspace");
  const researcherWorkspace = path.join(configRoot, "agents", "researcher", "workspace");
  await Promise.all([
    mkdir(primaryWorkspace, { recursive: true }),
    mkdir(researcherWorkspace, { recursive: true }),
  ]);
  await writeFile(path.join(primaryWorkspace, "evidence.txt"), "durable evidence\n", "utf8");

  const config = parseYaml(await readFile(configPath, "utf8")) as {
    models: Record<string, {
      model: string;
      baseUrl: string;
      apiKey: { fromEnvironment: string };
    }>;
  };
  const model = config.models.default;
  if (model === undefined) throw new Error("default_model_missing");
  model.model = "test-model";
  model.baseUrl = baseUrl;
  model.apiKey = { fromEnvironment: "E2E_MODEL_API_KEY" };
  await writeFile(configPath, stringifyYaml(config), "utf8");

  const policyPath = path.join(configRoot, "agents", "primary", "policy.yaml");
  const policy = parseYaml(await readFile(policyPath, "utf8")) as {
    rules: Array<{ tool: string; effect: string }>;
  };
  const commandRule = policy.rules.find((rule) => rule.tool === "run_command");
  if (commandRule === undefined) throw new Error("run_command_rule_missing");
  if (options.allowRunCommand !== false) commandRule.effect = "allow";
  await writeFile(policyPath, stringifyYaml(policy), "utf8");

  const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
  const previousModel = process.env.E2E_MODEL_API_KEY;
  process.env.MYAGENT_BEARER_TOKEN = BEARER_TOKEN;
  process.env.E2E_MODEL_API_KEY = MODEL_SECRET;

  return {
    root,
    configPath,
    databasePath,
    primaryWorkspace,
    researcherWorkspace,
    async cleanup(): Promise<void> {
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("E2E_MODEL_API_KEY", previousModel);
      await rm(root, { recursive: true, force: true });
    },
  };
}

export class E2eServiceController {
  #service: BootstrappedService | undefined;

  constructor(private readonly configPath: string) {}

  get url(): string {
    if (this.#service === undefined) throw new Error("service_not_started");
    return this.#service.url;
  }

  async start(): Promise<void> {
    if (this.#service !== undefined) throw new Error("service_already_started");
    this.#service = await bootstrap(this.configPath, {
      listen: { host: "127.0.0.1", port: 0 },
      signals: false,
      log: { write: () => {} },
    });
  }

  async restart(): Promise<void> {
    await this.stop();
    await this.start();
  }

  async stop(): Promise<void> {
    const service = this.#service;
    this.#service = undefined;
    await service?.shutdown();
  }
}

export interface ObservedEvent {
  runId: string;
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
}

export class AgentHttpClient {
  constructor(private readonly baseUrl: () => string) {}

  async createRun(input: {
    agentId: string;
    sessionKey: string;
    text: string;
    idempotencyKey: string;
  }): Promise<{ runId: string }> {
    const response = await this.request("/v1/runs", {
      method: "POST",
      headers: { "idempotency-key": input.idempotencyKey },
      body: JSON.stringify({
        agentId: input.agentId,
        sessionKey: input.sessionKey,
        input: { type: "text", text: input.text },
      }),
    });
    if (response.status !== 202) throw new Error(`create_run_failed:${String(response.status)}`);
    return await response.json() as { runId: string };
  }

  async onlyPendingApproval(): Promise<{ approvalId: string; runId: string }> {
    const response = await this.request("/v1/approvals?status=pending");
    const body = await response.json() as {
      approvals: Array<{ approvalId: string; runId: string }>;
    };
    if (body.approvals.length !== 1) {
      throw new Error(`expected_one_pending_approval:${String(body.approvals.length)}`);
    }
    return body.approvals[0]!;
  }

  async approve(approvalId: string): Promise<void> {
    const response = await this.request(`/v1/approvals/${approvalId}/decision`, {
      method: "POST",
      body: JSON.stringify({ decision: "approve" }),
    });
    if (response.status !== 200) throw new Error(`approval_failed:${String(response.status)}`);
  }

  async getRun(runId: string): Promise<{ status: string }> {
    const response = await this.request(`/v1/runs/${runId}`);
    return await response.json() as { status: string };
  }

  async waitForStatus(
    runId: string,
    expected: string | readonly string[],
    timeoutMs = 15_000,
  ): Promise<{ status: string }> {
    const accepted = new Set(Array.isArray(expected) ? expected : [expected]);
    const deadline = Date.now() + timeoutMs;
    while (true) {
      const run = await this.getRun(runId);
      if (accepted.has(run.status)) return run;
      if (Date.now() >= deadline) {
        throw new Error(`run_status_timeout:${run.status}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  async waitForEvent(
    runId: string,
    eventType: string,
    afterSequence = 0,
    timeoutMs = 15_000,
  ): Promise<ObservedEvent> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(new Error(`event_timeout:${eventType}`)),
      timeoutMs,
    );
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
    try {
      const response = await this.request(`/v1/runs/${runId}/events`, {
        headers: { "last-event-id": String(afterSequence) },
        signal: controller.signal,
      });
      if (response.body === null) throw new Error("sse_body_missing");
      reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        buffer += decoder.decode(next.value, { stream: true }).replaceAll("\r\n", "\n");
        let boundary = buffer.indexOf("\n\n");
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const event = parseSseEvent(block);
          if (event?.type === eventType) return event;
          boundary = buffer.indexOf("\n\n");
        }
      }
      throw new Error(`event_stream_ended:${eventType}`);
    } finally {
      clearTimeout(timeout);
      await reader?.cancel().catch(() => undefined);
      controller.abort();
    }
  }

  async readEventStream(
    runId: string,
    afterSequence = 0,
  ): Promise<ObservedEvent[]> {
    const response = await this.request(`/v1/runs/${runId}/events`, {
      headers: { "last-event-id": String(afterSequence) },
    });
    const payload = (await response.text()).replaceAll("\r\n", "\n");
    return payload
      .split("\n\n")
      .map(parseSseEvent)
      .filter((event): event is ObservedEvent => event !== null);
  }

  private request(pathname: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${this.baseUrl()}${pathname}`, {
      ...init,
      headers: {
        authorization: `Bearer ${BEARER_TOKEN}`,
        ...(init.body === undefined ? {} : { "content-type": "application/json" }),
        ...init.headers,
      },
    });
  }
}

export class FaultChildController {
  readonly armPath: string;
  readonly hitPath: string;
  readonly readyPath: string;

  #child: ChildProcess | undefined;
  #completed: Promise<void> | undefined;
  #url: string | undefined;

  constructor(
    private readonly fixture: Pick<E2eFixture, "configPath" | "root">,
    readonly point: FaultPoint,
  ) {
    this.armPath = path.join(fixture.root, `${point}.arm`);
    this.hitPath = path.join(fixture.root, `${point}.hit`);
    this.readyPath = path.join(fixture.root, `${point}.ready`);
  }

  get url(): string {
    if (this.#url === undefined) throw new Error("fault_child_not_ready");
    return this.#url;
  }

  async start(): Promise<void> {
    if (this.#child !== undefined) throw new Error("fault_child_already_started");
    const userInfoShim = path.resolve("test/helpers/os-user-info-shim.cjs");
    const child = spawn(
      process.execPath,
      [
        "--require",
        userInfoShim,
        path.resolve("node_modules/tsx/dist/cli.mjs"),
        path.resolve("test/helpers/fault-child.ts"),
      ],
      {
        cwd: path.resolve("."),
        env: {
          ...process.env,
          NODE_OPTIONS: [
            process.env.NODE_OPTIONS,
            `--require=${userInfoShim}`,
          ].filter(Boolean).join(" "),
          MYAGENT_FAULT_CONFIG: this.fixture.configPath,
          MYAGENT_FAULT_POINT: this.point,
          MYAGENT_FAULT_ARM: this.armPath,
          MYAGENT_FAULT_HIT: this.hitPath,
          MYAGENT_FAULT_READY: this.readyPath,
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    this.#child = child;
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
    this.#completed = new Promise<void>((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => {
        this.#child = undefined;
        if (code === 0 || signal !== null) resolve();
        else reject(new Error(`fault_child_exited:${String(code)}:${stderr.join("")}`));
      });
    });
    await Promise.race([
      waitForPath(this.readyPath, 15_000),
      this.#completed.then(() => { throw new Error(`fault_child_exited_before_ready:${stderr.join("")}`); }),
    ]);
    this.#url = JSON.parse(await readFile(this.readyPath, "utf8")) as string;
  }

  async arm(): Promise<void> {
    await writeFile(this.armPath, this.point, "utf8");
  }

  async waitForHit(timeoutMs = 15_000): Promise<void> {
    await waitForPath(this.hitPath, timeoutMs);
  }

  async crash(): Promise<void> {
    const child = this.#child;
    if (child !== undefined) child.kill();
    await this.#completed;
  }

  async stop(): Promise<void> {
    if (this.#child !== undefined) this.#child.kill();
    await this.#completed?.catch(() => undefined);
  }
}

export function countChildRuns(databasePath: string, parentRunId: string): number {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT COUNT(*) AS count FROM runs WHERE parent_run_id = ?",
    ).get(parentRunId) as { count: number };
    return row.count;
  } finally {
    database.close();
  }
}

export function readToolResult(databasePath: string, toolName: string): string {
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    const row = database.prepare(
      "SELECT result_json FROM tool_calls WHERE tool_name = ? ORDER BY created_at DESC LIMIT 1",
    ).get(toolName) as { result_json: string } | undefined;
    if (row === undefined) throw new Error(`tool_result_missing:${toolName}`);
    return row.result_json;
  } finally {
    database.close();
  }
}

function parseSseEvent(block: string): ObservedEvent | null {
  if (block.startsWith(":")) return null;
  const lines = block.split("\n");
  const data = lines.find((line) => line.startsWith("data: "))?.slice(6);
  if (data === undefined) return null;
  return JSON.parse(data) as ObservedEvent;
}

function frame(delta: JsonValue, finishReason: string | null = null): JsonValue {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [{ index: 0, delta, finish_reason: finishReason }],
    usage: null,
  };
}

function usageFrame(): JsonValue {
  return {
    id: "chatcmpl-e2e",
    object: "chat.completion.chunk",
    created: 0,
    model: "test-model",
    choices: [],
    usage: { prompt_tokens: 20, completion_tokens: 5, total_tokens: 25 },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

async function waitForPath(filePath: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!existsSync(filePath)) {
    if (Date.now() >= deadline) throw new Error(`file_timeout:${filePath}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
