import { cp, mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { bootstrap } from "../../src/bootstrap.js";

const FIXTURES = fileURLToPath(new URL("../fixtures/config", import.meta.url));

describe("bootstrap", () => {
  it("starts without resolving an unassigned provider secret", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-secret-"));
    await cp(path.join(FIXTURES, "valid"), path.join(root, "config"), { recursive: true });
    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MYAGENT_BEARER_TOKEN = "bootstrap-token";
    delete process.env.MODEL_API_KEY;
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    try {
      service = await bootstrap(path.join(root, "config", "myagent.yaml"), {
        listen: { host: "127.0.0.1", port: 0 },
        signals: false,
        log: { write: () => {} },
      });
      expect((await fetch(`${service.url}/healthz`)).status).toBe(200);
    } finally {
      await service?.shutdown();
      process.env.MYAGENT_BEARER_TOKEN = previousBearer;
      process.env.MODEL_API_KEY = previousModel;
      await rm(root, { recursive: true, force: true });
    }
  });

  it("loads configuration before listening and closes all resources on shutdown", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "myagent-bootstrap-"));
    await cp(path.join(FIXTURES, "valid"), path.join(root, "config"), { recursive: true });
    const previousBearer = process.env.MYAGENT_BEARER_TOKEN;
    const previousModel = process.env.MODEL_API_KEY;
    process.env.MYAGENT_BEARER_TOKEN = "bootstrap-token";
    process.env.MODEL_API_KEY = "model-token";
    let service: Awaited<ReturnType<typeof bootstrap>> | undefined;
    const sigintListeners = process.listenerCount("SIGINT");
    const sigtermListeners = process.listenerCount("SIGTERM");

    try {
      service = await bootstrap(path.join(root, "config", "myagent.yaml"), {
        listen: { host: "127.0.0.1", port: 0 },
        log: { write: () => {} },
      });
      expect(process.listenerCount("SIGINT")).toBe(sigintListeners + 1);
      expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners + 1);
      const response = await fetch(`${service.url}/healthz`);
      expect(response.status).toBe(200);
    } finally {
      await service?.shutdown();
      process.env.MYAGENT_BEARER_TOKEN = previousBearer;
      process.env.MODEL_API_KEY = previousModel;
      await rm(root, { recursive: true, force: true });
    }
    expect(process.listenerCount("SIGINT")).toBe(sigintListeners);
    expect(process.listenerCount("SIGTERM")).toBe(sigtermListeners);
  });
});
