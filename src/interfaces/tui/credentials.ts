export interface TuiCredentials {
  readonly runToken: string;
  readonly adminToken: string;
}

export interface ReadTuiCredentialsOptions {
  readonly environment: Readonly<Record<string, string | undefined>>;
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

export async function readTuiCredentials(options: ReadTuiCredentialsOptions): Promise<TuiCredentials> {
  const runToken = await readCredential(
    options.environment.MYAGENT_RUN_TOKEN,
    "Run token",
    "run_token_required",
    options.promptSecret,
  );
  const adminToken = await readCredential(
    options.environment.MYAGENT_ADMIN_TOKEN,
    "Admin token",
    "admin_token_required",
    options.promptSecret,
  );
  if (runToken === adminToken) throw new TuiTokensMustDifferError();
  return Object.freeze({ runToken, adminToken });
}

async function readCredential(
  configured: string | undefined,
  label: "Run token" | "Admin token",
  code: "run_token_required" | "admin_token_required",
  promptSecret: ReadTuiCredentialsOptions["promptSecret"],
): Promise<string> {
  const value = configured ?? await promptSecret(label);
  if (value.trim().length === 0) throw new TuiCredentialRequiredError(code);
  return value;
}
