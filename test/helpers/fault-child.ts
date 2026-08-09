import { existsSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { EnvironmentSecretResolver } from "../../src/adapters/environment-secret-resolver.js";
import { OpenAiChatCompletionsModel } from "../../src/adapters/model/openai-chat-completions.js";
import { NodeProviderHttpTransport } from "../../src/adapters/provider-http-transport.js";
import { SqliteModelRegistryRepository } from "../../src/adapters/sqlite/model-registry-repository.js";
import { bootstrap } from "../../src/bootstrap.js";
import type { ModelPort } from "../../src/ports/model.js";
import type { FaultInjector, FaultPoint } from "../../src/runtime/fault-injector.js";

const configPath = requiredEnvironment("MYAGENT_FAULT_CONFIG");
const databasePath = requiredEnvironment("MYAGENT_FAULT_DATABASE");
const selected = process.env.MYAGENT_FAULT_POINT as FaultPoint | undefined;
const armPath = requiredEnvironment("MYAGENT_FAULT_ARM");
const hitPath = requiredEnvironment("MYAGENT_FAULT_HIT");
const readyPath = requiredEnvironment("MYAGENT_FAULT_READY");
const modelAckMarker = process.env.MYAGENT_MODEL_ACK_MARKER;
const modelAckPath = process.env.MYAGENT_MODEL_ACK_PATH;

const faults: FaultInjector = {
  async hit(point): Promise<void> {
    if (point !== selected || !existsSync(armPath)) return;
    try {
      writeFileSync(hitPath, point, { encoding: "utf8", flag: "wx" });
    } catch (error) {
      if (!hasErrorCode(error, "EEXIST")) throw error;
    }
    await new Promise<never>(() => {});
  },
};

const innerModel = new OpenAiChatCompletionsModel({
  transport: new NodeProviderHttpTransport({
    secretResolver: new EnvironmentSecretResolver(),
  }),
  connections: new SqliteModelRegistryRepository(new DatabaseSync(databasePath)),
});
const model = modelAckMarker === undefined || modelAckPath === undefined
  ? innerModel
  : acknowledgeConsumedDelta(innerModel, modelAckMarker, modelAckPath);

bootstrap(configPath, {
  listen: { host: "127.0.0.1", port: 0 },
  signals: false,
  faults,
  model,
  worker: {
    concurrency: 1,
    leaseDurationMs: 250,
    idleDelayMs: 1_000,
  },
  log: { write: () => {} },
}).then((service) => {
  writeFileSync(readyPath, JSON.stringify(service.url), "utf8");
}).catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});

function requiredEnvironment(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`missing_environment:${name}`);
  return value;
}

function hasErrorCode(error: unknown, code: string): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === code;
}

function acknowledgeConsumedDelta(
  inner: ModelPort,
  marker: string,
  ackPath: string,
): ModelPort {
  return {
    async *streamAttempt(request, signal) {
      for await (const chunk of inner.streamAttempt(request, signal)) {
        yield chunk;
        if (chunk.type === "text_delta" && chunk.text === marker) {
          writeFileSync(ackPath, marker, { encoding: "utf8", flag: "wx" });
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
      }
    },
  };
}
