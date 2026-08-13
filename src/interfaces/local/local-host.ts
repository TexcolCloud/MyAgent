import { randomBytes } from "node:crypto";

import { bootstrap } from "../../bootstrap.js";
import { TuiClient } from "../tui/tui-client.js";
import { runWorkbench, type RunWorkbenchOptions } from "../tui/workbench.js";
import { inspectExitImpact } from "./exit-impact.js";

export interface LocalHostDependencies {
  readonly bootstrapService: typeof bootstrap;
  readonly generateToken: () => string;
  readonly runTui: (options: RunWorkbenchOptions) => Promise<number>;
}

export async function runLocalHost(input: {
  readonly configPath: string;
  readonly projectStateRoot: string;
  readonly dependencies?: Partial<LocalHostDependencies>;
}): Promise<number> {
  const bootstrapService = input.dependencies?.bootstrapService ?? bootstrap;
  const generateToken = input.dependencies?.generateToken ?? generateLocalToken;
  const runTui = input.dependencies?.runTui ?? runWorkbench;
  const runToken = generateToken();
  let adminToken = generateToken();
  while (adminToken === runToken) adminToken = generateToken();
  const service = await bootstrapService(input.configPath, {
    auth: Object.freeze({ bearerToken: runToken, adminToken }),
    listen: { host: "127.0.0.1", port: 0 },
    projectStateRoot: input.projectStateRoot,
    signals: false,
  });
  try {
    const client = new TuiClient({ apiUrl: service.url, runToken, adminToken });
    return await runTui({
      client,
      beforeExit: () => inspectExitImpact(client),
    });
  } finally {
    await service.shutdown();
  }
}

function generateLocalToken(): string {
  const bytes = randomBytes(32);
  try {
    return bytes.toString("base64url");
  } finally {
    bytes.fill(0);
  }
}
