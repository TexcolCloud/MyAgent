import {
  CliPromptCancelledError,
  type CliPrompt,
  type CliPromptChoice,
  type SetupModelProgressCallback,
} from "../../cli/commands/model-setup.js";
import { isRevisionConflict } from "../tui-client.js";

export interface ModelSetupAdminClient {
  runModelSetup(input: {
    readonly prompt: CliPrompt;
    readonly sleep: (milliseconds: number) => Promise<void>;
    readonly write: (line: string) => void;
    readonly onProgress?: SetupModelProgressCallback;
    readonly signal?: AbortSignal;
  }): Promise<number>;
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
  | { readonly status: "conflict"; readonly reloadRequired: true }
  | { readonly status: "failed"; readonly exitCode: number };

export async function runModelSetupScreen(options: RunModelSetupScreenOptions): Promise<ModelSetupScreenOutcome> {
  const output: string[] = [];
  let exitCode: number;
  try {
    exitCode = await awaitCancellation(options.client.runModelSetup({
      prompt: abortablePrompt(options.prompt, options.signal),
      sleep: (milliseconds) => options.sleep === undefined
        ? delay(milliseconds, options.signal)
        : awaitCancellation(options.sleep(milliseconds), options.signal),
      write: (line) => {
        output.push(line);
        options.write(line);
      },
      ...(options.signal === undefined ? {} : { signal: options.signal }),
      ...(options.onProgress === undefined ? {} : { onProgress: options.onProgress }),
    }), options.signal);
  } catch (error) {
    output.length = 0;
    if (error instanceof CliPromptCancelledError) return { status: "cancelled" };
    if (isRevisionConflict(error)) return { status: "conflict", reloadRequired: true };
    throw error;
  }
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
  assertNotAborted(signal);
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
