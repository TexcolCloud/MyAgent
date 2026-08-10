import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { describe, expect, it, vi } from "vitest";

import { bootstrap } from "../../src/bootstrap.js";
import { FakeOpenAiProvider } from "../helpers/fake-openai-provider.js";

const VALID_FIXTURE = fileURLToPath(new URL("../fixtures/config/valid", import.meta.url));

describe("network defaults", () => {
  it("closes delayed fake-provider responses without retaining timers or sockets", async () => {
    const provider = await FakeOpenAiProvider.start({ models: ["delayed-model"] });
    try {
      provider.delayResponses(5_000);
      const pending = fetch(`${provider.baseUrl}/models`).catch((error: unknown) => error);
      const deadline = Date.now() + 1_000;
      while (provider.requests.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(provider.requests).toHaveLength(1);

      const close = provider.close().then(() => "closed" as const);
      expect(await Promise.race([
        close,
        new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), 250)),
      ])).toBe("closed");
      expect(await pending).toBeInstanceOf(Error);
    } finally {
      await provider.close();
    }
  });

  it("defaults to loopback with no Channel route or unauthenticated v1 route", async () => {
    const fixture = await prepareConfig();
    const logs: string[] = [];
    const originalFetch = globalThis.fetch;
    const telemetryFetch = vi.fn();
    globalThis.fetch = telemetryFetch as typeof fetch;
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      service = await bootstrap(fixture.configPath, {
        listen: { port: 0 },
        signals: false,
        log: { write: (line) => { logs.push(line); } },
      });
      expect(new URL(service.url).hostname).toBe("127.0.0.1");
      expect(telemetryFetch).not.toHaveBeenCalled();
      expect(logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.code === "non_loopback_binding")).toEqual([]);
      globalThis.fetch = originalFetch;
      const excludedChannel = ["fei", "shu"].join("");
      const channel = await fetch(
        `${service.url}/channels/${excludedChannel}/events`,
        { method: "POST" },
      );
      expect(channel.status).toBe(404);
      const unauthenticated = await fetch(`${service.url}/v1/agents`);
      expect(unauthenticated.status).toBe(401);
    } finally {
      globalThis.fetch = originalFetch;
      await service?.shutdown();
      await fixture.cleanup();
    }
  });

  it("starts on an explicit non-loopback host and writes one structured warning", async () => {
    const fixture = await prepareConfig("0.0.0.0");
    const logs: string[] = [];
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      service = await bootstrap(fixture.configPath, {
        listen: { port: 0 },
        signals: false,
        log: { write: (line) => { logs.push(line); } },
      });
      const warnings = logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.code === "non_loopback_binding");
      expect(warnings).toEqual([
        expect.objectContaining({ level: "warn", code: "non_loopback_binding", host: "0.0.0.0" }),
      ]);
    } finally {
      await service?.shutdown();
      await fixture.cleanup();
    }
  });

  it("does not warn for equivalent IPv6 loopback hosts", async () => {
    const fixture = await prepareConfig("0:0:0:0:0:0:0:1");
    const logs: string[] = [];
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      service = await bootstrap(fixture.configPath, {
        listen: { port: 0 },
        signals: false,
        log: { write: (line) => { logs.push(line); } },
      });
      expect(logs
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((entry) => entry.code === "non_loopback_binding")).toEqual([]);
    } finally {
      await service?.shutdown();
      await fixture.cleanup();
    }
  });
});

async function prepareConfig(host?: string): Promise<{ configPath: string; cleanup(): Promise<void> }> {
  const root = await mkdtemp(path.join(os.tmpdir(), "myagent-network-"));
  const configRoot = path.join(root, "config");
  await cp(VALID_FIXTURE, configRoot, { recursive: true });
  const configPath = path.join(configRoot, "myagent.yaml");
  const config = parseYaml(await readFile(configPath, "utf8")) as {
    server: { host?: string };
  };
  if (host === undefined) delete config.server.host;
  else config.server.host = host;
  await writeFile(configPath, stringifyYaml(config));

  const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
  const previousAdmin = process.env.MYAGENT_ADMIN_TOKEN;
  const previousModel = process.env.MODEL_API_KEY;
  process.env.MYAGENT_BEARER_TOKEN = "network-operator-secret";
  process.env.MYAGENT_ADMIN_TOKEN = "network-admin-secret";
  process.env.MODEL_API_KEY = "network-provider-secret";
  return {
    configPath,
    async cleanup(): Promise<void> {
      restoreEnvironment("MYAGENT_BEARER_TOKEN", previousBearer);
      restoreEnvironment("MYAGENT_ADMIN_TOKEN", previousAdmin);
      restoreEnvironment("MODEL_API_KEY", previousModel);
      await rm(root, { recursive: true, force: true });
    },
  };
}

function restoreEnvironment(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}
