export interface TuiCredentials {
  readonly runToken: string;
  readonly adminToken: string;
}

export type TuiCredentialSource = "credential helper" | "environment" | "masked prompt";

export interface ReadTuiCredentialsResult extends TuiCredentials {
  readonly sources: {
    readonly run: TuiCredentialSource;
    readonly admin: TuiCredentialSource;
  };
}

export type TuiCredentialHelper = () => Promise<Partial<TuiCredentials> | undefined>;

export interface ReadTuiCredentialsOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly credentialHelper?: TuiCredentialHelper;
  readonly promptSecret: (label: "Run token" | "Admin token") => Promise<string>;
}

export class TuiCredentialRequiredError extends Error {
  readonly traceId = "cli";
  readonly detail: string;

  constructor(readonly code: "run_token_required" | "admin_token_required") {
    super(code);
    this.detail = code === "run_token_required"
      ? "Run authentication is required."
      : "Admin authentication is required.";
  }
}

export class TuiTokensMustDifferError extends Error {
  readonly code = "tui_tokens_must_differ";
  readonly detail = "Run and Admin tokens must differ.";
  readonly traceId = "cli";

  constructor() {
    super("tui_tokens_must_differ");
  }
}

export async function readTuiCredentials(options: ReadTuiCredentialsOptions): Promise<ReadTuiCredentialsResult> {
  const helped = await options.credentialHelper?.() ?? {};
  const run = await readCredential(
    helped.runToken,
    options.environment.MYAGENT_RUN_TOKEN,
    "Run token",
    "run_token_required",
    options.promptSecret,
  );
  const admin = await readCredential(
    helped.adminToken,
    options.environment.MYAGENT_ADMIN_TOKEN,
    "Admin token",
    "admin_token_required",
    options.promptSecret,
  );
  if (run.value === admin.value) throw new TuiTokensMustDifferError();
  return Object.freeze({
    runToken: run.value,
    adminToken: admin.value,
    sources: Object.freeze({ run: run.source, admin: admin.source }),
  });
}

async function readCredential(
  helped: string | undefined,
  configured: string | undefined,
  label: "Run token" | "Admin token",
  code: "run_token_required" | "admin_token_required",
  promptSecret: ReadTuiCredentialsOptions["promptSecret"],
): Promise<{ readonly value: string; readonly source: TuiCredentialSource }> {
  const source = helped !== undefined
    ? "credential helper"
    : configured !== undefined
      ? "environment"
      : "masked prompt";
  const value = helped ?? configured ?? await promptSecret(label);
  if (value.trim().length === 0) throw new TuiCredentialRequiredError(code);
  return { value, source };
}
