import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { createServer, type Server, type ServerResponse } from "node:http";
import { cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";

import { DatabaseSync } from "node:sqlite";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

import { openDatabase } from "../../src/adapters/sqlite/database.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { migrate } from "../../src/adapters/sqlite/migrator.js";
import { bootstrap, type BootstrappedService } from "../../src/bootstrap.js";
import { parseAgentId } from "../../src/domain/ids.js";
import type { JsonValue } from "../../src/domain/json.js";
import type { FaultPoint } from "../../src/runtime/fault-injector.js";
import { seedVerifiedChatAssignments } from "./verified-chat-model-registry.js";

const EXAMPLES = fileURLToPath(new URL("../../examples", import.meta.url));
const BEARER_TOKEN = "e2e-operator-secret";
const MODEL_SECRET = "e2e-provider-secret";

export type ProviderTurn =
  | { type: "tool"; name: string; arguments: JsonValue }
  | { type: "text"; text: string }
  | { type: "held_text"; text: string }
  | { type: "error"; status: number; code: string };

export interface CapturedProviderRequest {
  model?: unknown;
  messages?: unknown;
  tools?: unknown;
}

export class ScriptedChatServer {
  readonly requests: CapturedProviderRequest[] = [];
  readonly baseUrl: string;
  readonly heldTextWritten: Promise<string>;
  private resolveHeldTextWritten!: (text: string) => void;

  private constructor(
    private readonly server: Server,
    private readonly turns: ProviderTurn[],
    port: number,
  ) {
    this.baseUrl = `http://127.0.0.1:${String(port)}/v1`;
    this.heldTextWritten = new Promise((resolve) => {
      this.resolveHeldTextWritten = resolve;
    });
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

    if (turn.type === "error") {
      response.writeHead(turn.status, { "content-type": "application/json" });
      response.end(JSON.stringify({
        error: {
          message: turn.code,
          type: "scripted_provider_error",
          code: turn.code,
        },
      }));
      return;
    }

    response.writeHead(200, { "content-type": "text/event-stream" });
    if (turn.type === "held_text") {
      response.write(
        `data: ${JSON.stringify(frame({ content: turn.text }))}\n\n`,
        () => { this.resolveHeldTextWritten(turn.text); },
      );
      return;
    }
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

export async function removeE2eFixtureRoot(
  root: string,
  options: {
    releaseTimeoutMs?: number;
    onClaimed?(claimedRoot: string): void | Promise<void>;
  } = {},
): Promise<void> {
  const claimedRoot = await claimE2eFixtureRoot(
    root,
    options.releaseTimeoutMs ?? 5_000,
  );
  if (claimedRoot === undefined) return;
  await options.onClaimed?.(claimedRoot);
  await rm(claimedRoot, { recursive: true, force: true });
}

export async function prepareE2eFixture(
  baseUrl: string,
  options: {
    allowRunCommand?: boolean;
    maxInputTokens?: number;
    modelId?: string;
    providerApiKeyEnvironment?: string;
  } = {},
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
    mkdir(path.dirname(databasePath), { recursive: true }),
  ]);
  await writeFile(path.join(primaryWorkspace, "evidence.txt"), "durable evidence\n", "utf8");

  const policyPath = path.join(configRoot, "agents", "primary", "policy.yaml");
  const policy = parseYaml(await readFile(policyPath, "utf8")) as {
    rules: Array<{ tool: string; effect: string }>;
  };
  const commandRule = policy.rules.find((rule) => rule.tool === "run_command");
  if (commandRule === undefined) throw new Error("run_command_rule_missing");
  if (options.allowRunCommand !== false) commandRule.effect = "allow";
  await writeFile(policyPath, stringifyYaml(policy), "utf8");

  const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
  const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
  const previousModel = process.env.E2E_MODEL_API_KEY;
  process.env.MYAGENT_BEARER_TOKEN = BEARER_TOKEN;
  process.env.MYAGENT_ADMIN_TOKEN = "e2e-admin-token";
  process.env.E2E_MODEL_API_KEY = MODEL_SECRET;
  const connection = openDatabase({ path: databasePath, busyTimeoutMs: 5_000 });
  try {
    migrate(connection.db);
    seedVerifiedChatAssignments(
      new SqliteModelRegistryRepository(connection.db),
      [parseAgentId("primary"), parseAgentId("researcher")],
      {
        baseUrl,
        providerAuth: {
          type: "bearer",
          secret: {
            fromEnvironment: options.providerApiKeyEnvironment ?? "E2E_MODEL_API_KEY",
          },
        },
        ...(options.modelId === undefined ? {} : { modelId: options.modelId }),
        ...(options.maxInputTokens === undefined
          ? {}
          : { maxInputTokens: options.maxInputTokens }),
      },
    );
  } finally {
    connection.close();
  }

  return {
    root,
    configPath,
    databasePath,
    primaryWorkspace,
    researcherWorkspace,
    async cleanup(): Promise<void> {
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      restoreEnvironment("E2E_MODEL_API_KEY", previousModel);
      await removeE2eFixtureRoot(root);
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
  readonly modelAckPath: string;

  #child: ChildProcess | undefined;
  #completed: Promise<void> | undefined;
  #termination: AbortController | undefined;
  #url: string | undefined;

  constructor(
    private readonly fixture: Pick<E2eFixture, "configPath" | "databasePath" | "root">,
    readonly point: FaultPoint | undefined,
    private readonly modelAckMarker?: string,
  ) {
    const label = point ?? "no-fault";
    this.armPath = path.join(fixture.root, `${label}.arm`);
    this.hitPath = path.join(fixture.root, `${label}.hit`);
    this.readyPath = path.join(fixture.root, `${label}.ready`);
    this.modelAckPath = path.join(fixture.root, `${label}.model-ack`);
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
          MYAGENT_FAULT_DATABASE: this.fixture.databasePath,
          MYAGENT_FAULT_ARM: this.armPath,
          MYAGENT_FAULT_HIT: this.hitPath,
          MYAGENT_FAULT_READY: this.readyPath,
          ...(this.point === undefined
            ? {}
            : { MYAGENT_FAULT_POINT: this.point }),
          ...(this.modelAckMarker === undefined
            ? {}
            : {
                MYAGENT_MODEL_ACK_MARKER: this.modelAckMarker,
                MYAGENT_MODEL_ACK_PATH: this.modelAckPath,
              }),
        },
        stdio: ["ignore", "ignore", "pipe"],
        windowsHide: true,
      },
    );
    this.#child = child;
    const termination = new AbortController();
    this.#termination = termination;
    const stderr: string[] = [];
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => stderr.push(chunk));
    child.once("close", () => {
      if (this.#child === child) this.#child = undefined;
      if (this.#termination === termination) this.#termination = undefined;
    });
    this.#completed = waitForFaultChildCompletion(child, this.fixture.root, stderr, {
      terminationSignal: termination.signal,
    });
    await Promise.race([
      waitForPath(this.readyPath, 15_000),
      this.#completed.then(() => { throw new Error(`fault_child_exited_before_ready:${stderr.join("")}`); }),
    ]);
    this.#url = JSON.parse(await readFile(this.readyPath, "utf8")) as string;
  }

  async arm(): Promise<void> {
    if (this.point === undefined) throw new Error("fault_point_not_configured");
    await writeFile(this.armPath, this.point, "utf8");
  }

  async waitForHit(timeoutMs = 15_000): Promise<void> {
    if (this.point === undefined) throw new Error("fault_point_not_configured");
    await waitForPath(this.hitPath, timeoutMs);
  }

  async waitForModelAck(timeoutMs = 15_000): Promise<void> {
    if (this.modelAckMarker === undefined) {
      throw new Error("model_ack_not_configured");
    }
    await waitForPath(this.modelAckPath, timeoutMs);
  }

  async crash(): Promise<void> {
    this.terminateChild();
    await this.#completed;
  }

  async stop(): Promise<void> {
    this.terminateChild();
    try {
      await this.#completed;
    } catch (error) {
      if (!(error instanceof FaultChildExitError)) throw error;
    }
  }

  private terminateChild(): void {
    const child = this.#child;
    if (child === undefined) return;
    try {
      child.kill();
    } finally {
      this.#termination?.abort();
    }
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

export function waitForFaultChildCompletion(
  child: ChildProcess,
  root: string,
  stderr: readonly string[],
  options: {
    closeTimeoutMs?: number;
    terminationSignal?: AbortSignal;
  } = {},
): Promise<void> {
  const closeTimeoutMs = options.closeTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(closeTimeoutMs) || closeTimeoutMs <= 0) {
    return Promise.reject(new Error("invalid_fault_child_close_timeout"));
  }

  let processError: unknown;
  return new Promise<void>((resolve, reject) => {
    let closed = false;
    let closeTimer: ReturnType<typeof setTimeout> | undefined;
    const beginCloseDeadline = (): void => {
      if (closed || closeTimer !== undefined) return;
      closeTimer = setTimeout(() => {
        options.terminationSignal?.removeEventListener("abort", beginCloseDeadline);
        reject(new FaultChildCloseTimeoutError());
      }, closeTimeoutMs);
    };
    child.once("error", (error) => {
      processError = error;
      beginCloseDeadline();
    });
    if (options.terminationSignal?.aborted === true) beginCloseDeadline();
    else options.terminationSignal?.addEventListener("abort", beginCloseDeadline, { once: true });
    child.once("close", (code, signal) => {
      closed = true;
      if (closeTimer !== undefined) clearTimeout(closeTimer);
      options.terminationSignal?.removeEventListener("abort", beginCloseDeadline);
      void waitForE2eFixtureRootRelease(root).then(() => {
        if (processError !== undefined) {
          reject(processError);
        } else if (code === 0 || signal !== null) {
          resolve();
        } else {
          reject(new FaultChildExitError(code, stderr));
        }
      }, reject);
    });
  });
}

export async function waitForE2eFixtureRootRelease(
  root: string,
  options: {
    releaseTimeoutMs?: number;
    onProbed?(probeRoot: string): void | Promise<void>;
  } = {},
): Promise<void> {
  if (process.platform !== "win32") return;
  const timeoutMs = options.releaseTimeoutMs ?? 5_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid_e2e_fixture_release_timeout");
  }

  const probe = `${root}.release-probe-${String(process.pid)}`;
  if (!existsSync(root)) {
    if (!existsSync(probe)) return;
    await renameWithWindowsContentionRetry(
      probe,
      root,
      timeoutMs,
      "e2e_fixture_root_restore_timeout",
      true,
    );
    return;
  }
  if (existsSync(probe)) throw new Error("e2e_fixture_release_probe_conflict");

  await renameWithWindowsContentionRetry(
    root,
    probe,
    timeoutMs,
    "e2e_fixture_root_release_timeout",
    false,
  );
  let probeError: unknown;
  try {
    await options.onProbed?.(probe);
  } catch (error) {
    probeError = error;
  }
  await renameWithWindowsContentionRetry(
    probe,
    root,
    timeoutMs,
    "e2e_fixture_root_restore_timeout",
    true,
  );
  if (probeError !== undefined) throw probeError;
}

async function claimE2eFixtureRoot(
  root: string,
  timeoutMs: number,
): Promise<string | undefined> {
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new Error("invalid_e2e_fixture_release_timeout");
  }
  const claimedRoot = `${root}.cleanup-claim`;
  if (existsSync(claimedRoot)) return claimedRoot;
  if (!existsSync(root)) return undefined;
  if (process.platform !== "win32") {
    await rename(root, claimedRoot);
    return claimedRoot;
  }
  await renameWithWindowsContentionRetry(
    root,
    claimedRoot,
    timeoutMs,
    "e2e_fixture_root_release_timeout",
    false,
  );
  return claimedRoot;
}

async function renameWithWindowsContentionRetry(
  source: string,
  destination: string,
  timeoutMs: number,
  timeoutCode: string,
  destinationMayExist: boolean,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (true) {
    try {
      await rename(source, destination);
      return;
    } catch (error) {
      if (!isWindowsRenameContention(error, destinationMayExist)) throw error;
      if (Date.now() >= deadline) throw new Error(timeoutCode, { cause: error });
      await delay(Math.min(20, Math.max(1, deadline - Date.now())));
    }
  }
}

function isWindowsRenameContention(
  error: unknown,
  destinationMayExist: boolean,
): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return error.code === "EPERM" ||
    error.code === "EBUSY" ||
    error.code === "EACCES" ||
    (destinationMayExist && (error.code === "EEXIST" || error.code === "ENOTEMPTY"));
}

class FaultChildExitError extends Error {
  constructor(code: number | null, stderr: readonly string[]) {
    super(`fault_child_exited:${String(code)}:${stderr.join("")}`);
    this.name = "FaultChildExitError";
  }
}

class FaultChildCloseTimeoutError extends Error {
  constructor() {
    super("fault_child_close_timeout");
    this.name = "FaultChildCloseTimeoutError";
  }
}
