import {
  setupModel,
  type CliPrompt,
  type SetupModelProgressCallback,
} from "../../cli/commands/model-setup.js";
import type { AdminClient, AdminRequestInit } from "../../cli/commands/providers.js";

export interface ModelSetupAdminClient {
  adminRequest<T>(path: string, init?: {
    method?: string;
    body?: unknown;
    idempotencyKey?: string;
  }): Promise<T>;
}

export interface RunModelSetupScreenOptions {
  readonly prompt: CliPrompt;
  readonly client: ModelSetupAdminClient;
  readonly write: (line: string) => void;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onProgress?: SetupModelProgressCallback;
}

export type ModelSetupScreenOutcome =
  | { readonly status: "configured" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly exitCode: number };

export async function runModelSetupScreen(options: RunModelSetupScreenOptions): Promise<ModelSetupScreenOutcome> {
  const output: string[] = [];
  const client: AdminClient = {
    request: <T>(path: string, init: AdminRequestInit = {}) =>
      options.client.adminRequest<T>(path, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.idempotencyKey === undefined ? {} : { idempotencyKey: init.idempotencyKey }),
      }),
  };
  const exitCode = await setupModel(
    client,
    options.prompt,
    options.sleep ?? delay,
    (line) => {
      output.push(line);
      options.write(line);
    },
    true,
    options.onProgress,
  );
  if (exitCode !== 0) return { status: "failed", exitCode };
  const result = output.at(-1);
  if (result !== undefined) {
    try {
      if ((JSON.parse(result) as { status?: unknown }).status === "cancelled") {
        return { status: "cancelled" };
      }
    } catch {
      // setupModel owns safe output formatting; an unstructured success is configured.
    }
  }
  return { status: "configured" };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
