import {
  CliPromptCancelledError,
  setupModel,
  type CliPrompt,
  type CliPromptChoice,
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
  readonly signal?: AbortSignal;
}

export type ModelSetupScreenOutcome =
  | { readonly status: "configured" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly exitCode: number };

export async function runModelSetupScreen(options: RunModelSetupScreenOptions): Promise<ModelSetupScreenOutcome> {
  const output: string[] = [];
  const client: AdminClient = {
    request: async <T>(path: string, init: AdminRequestInit = {}) => {
      assertNotAborted(options.signal);
      const result = await options.client.adminRequest<T>(path, {
        ...(init.method === undefined ? {} : { method: init.method }),
        ...(init.body === undefined ? {} : { body: init.body }),
        ...(init.idempotencyKey === undefined ? {} : { idempotencyKey: init.idempotencyKey }),
      });
      assertNotAborted(options.signal);
      return result;
    },
  };
  const exitCode = await setupModel(
    client,
    abortablePrompt(options.prompt, options.signal),
    (milliseconds) => options.sleep === undefined
      ? delay(milliseconds, options.signal)
      : awaitCancellation(options.sleep(milliseconds), options.signal),
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

function abortablePrompt(prompt: CliPrompt, signal: AbortSignal | undefined): CliPrompt {
  return {
    select: <T extends string>(message: string, choices: readonly T[]) => awaitCancellation(prompt.select(message, choices), signal),
    selectChoice: <T extends string>(message: string, choices: readonly CliPromptChoice<T>[]) => awaitCancellation(
      prompt.selectChoice === undefined
        ? prompt.select(message, choices.map((choice) => choice.value))
        : prompt.selectChoice(message, choices),
      signal,
    ),
    input: (message: string, initial?: string) => awaitCancellation(prompt.input(message, initial), signal),
    secret: (message: string) => awaitCancellation(prompt.secret(message), signal),
    confirm: (message: string) => awaitCancellation(prompt.confirm(message), signal),
  };
}

function assertNotAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted === true) throw new CliPromptCancelledError();
}

function awaitCancellation<T>(operation: Promise<T>, signal: AbortSignal | undefined): Promise<T> {
  if (signal === undefined) return operation;
  assertNotAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new CliPromptCancelledError());
    signal.addEventListener("abort", abort, { once: true });
    void operation.then(
      (value) => { signal.removeEventListener("abort", abort); resolve(value); },
      (error: unknown) => { signal.removeEventListener("abort", abort); reject(error); },
    );
  });
}

function delay(milliseconds: number, signal: AbortSignal | undefined): Promise<void> {
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      reject(new CliPromptCancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal?.addEventListener("abort", abort, { once: true });
  });
}
