import { existsSync, writeFileSync } from "node:fs";

import { bootstrap } from "../../src/bootstrap.js";
import type { FaultInjector, FaultPoint } from "../../src/runtime/fault-injector.js";

const configPath = requiredEnvironment("MYAGENT_FAULT_CONFIG");
const selected = requiredEnvironment("MYAGENT_FAULT_POINT") as FaultPoint;
const armPath = requiredEnvironment("MYAGENT_FAULT_ARM");
const hitPath = requiredEnvironment("MYAGENT_FAULT_HIT");
const readyPath = requiredEnvironment("MYAGENT_FAULT_READY");

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

bootstrap(configPath, {
  listen: { host: "127.0.0.1", port: 0 },
  signals: false,
  faults,
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
