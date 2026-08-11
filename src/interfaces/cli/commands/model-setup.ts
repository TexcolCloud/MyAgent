import { Writable } from "node:stream";
import { createInterface } from "node:readline/promises";

import { CliValidationError, type CliClient } from "../client.js";
import { writeJson, writeProblem, type CliWrite } from "../formatters.js";
import { pollVerification, type VerificationView } from "./models.js";

export interface CliPrompt {
  select<T extends string>(message: string, choices: readonly T[]): Promise<T>;
  input(message: string, initial?: string): Promise<string>;
  secret(message: string): Promise<string>;
  confirm(message: string): Promise<boolean>;
}

interface ProviderResponse {
  readonly connectionId: string;
  readonly recordRevision: number;
  readonly revisions: readonly [{
    readonly revisionId: string;
    readonly baseUrl: string;
    readonly protocolPreference: "chat_completions" | "responses";
  }];
}

interface ProviderDriverCatalogResponse {
  readonly drivers: readonly {
    readonly driverId: string;
    readonly candidates: readonly {
      readonly candidateId: string;
      readonly displayName: string;
      readonly modelId: string;
      readonly credentialSupport: "bearer" | "none" | "unsupported";
    }[];
  }[];
}

interface DiscoveryResponse {
  readonly recordRevision: number;
  readonly state: "fresh" | "stale" | "empty" | "unsupported" | "failed";
  readonly models: readonly { readonly id: string }[];
  readonly error: { readonly code: string; readonly traceId: string } | null;
}

interface ProfileResponse {
  readonly profileId: string;
  readonly recordRevision: number;
  readonly revisions: readonly {
    readonly revisionId: string;
    readonly invocationProtocol: "chat_completions" | "responses";
    readonly maxInputTokens: number;
    readonly contextWindowSource: "preset" | "operator" | "assumed_32768";
  }[];
}

export async function setupModel(
  client: CliClient,
  prompt: CliPrompt,
  sleep: (milliseconds: number) => Promise<void>,
  write: CliWrite,
  json: boolean,
): Promise<number> {
  const catalog = await client.request<ProviderDriverCatalogResponse>(
    "/v1/admin/provider-drivers",
    { authority: "admin" },
  );

  // 1. Select a stable Driver and, for native Drivers, a Catalog Model Candidate.
  const selectedKind = await prompt.select("Provider", ["openai", "deepseek", "custom"] as const);
  const driverId = selectedKind === "custom"
    ? "pi/openai-compatible"
    : `pi/${selectedKind}`;
  const preset = presets[selectedKind];

  // 2. Collect the immutable connection destination and credential reference.
  const slug = requiredAnswer(await prompt.input("Provider slug", selectedKind));
  const displayName = requiredAnswer(await prompt.input("Provider display name", title(selectedKind)));
  const baseUrl = requiredAnswer(await prompt.input("Base URL", preset.baseUrl));
  const catalogCandidate = selectedKind === "custom"
    ? undefined
    : await selectCatalogCandidate(catalog, driverId, prompt);
  const authChoices = selectedKind === "custom"
    ? ["environment", "managed_secret", "none"] as const
    : ["environment", "managed_secret"] as const;
  const authMode = await prompt.select("Provider auth", authChoices);
  const credential = authMode === "environment"
    ? { auth: { type: "environment" as const, fromEnvironment: requiredAnswer(await prompt.input("API key environment variable")) } }
    : authMode === "managed_secret"
      ? { auth: { type: "api_key" as const }, apiKey: requiredAnswer(await prompt.secret("API key")) }
      : { auth: { type: "none" as const } };

  // 3. Persist the connection draft and optional managed Secret version.
  const connection = await client.request<ProviderResponse>("/v1/admin/provider-connections", {
    authority: "admin",
    method: "POST",
    body: {
      slug,
      displayName,
      driverId,
      baseUrl,
      ...credential,
      protocolPreference: preset.protocol,
    },
  });
  const connectionRevision = connection.revisions.at(-1);
  if (connectionRevision === undefined) throw new Error("invalid_control_plane_response");

  // 4. Discover models; manual entry is offered only for safe terminal discovery states.
  const discovery = await client.request<DiscoveryResponse>(`/v1/admin/provider-connection-revisions/${encodeURIComponent(connectionRevision.revisionId)}/discover`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision: connection.recordRevision },
  });
  if (discovery.state === "failed") {
    writeProblem(write, {
      code: discovery.error?.code ?? "provider_unavailable",
      detail: "Provider model discovery failed.",
      traceId: discovery.error?.traceId ?? "unknown",
    }, json);
    return 5;
  }
  const manual = selectedKind === "custom" &&
    (discovery.state === "empty" || discovery.state === "unsupported");
  if (!manual && discovery.models.length === 0) throw new Error("invalid_control_plane_response");

  // 5. Select the model and resolve an explicit context source.
  const modelId = catalogCandidate?.modelId ?? (manual
    ? requiredAnswer(await prompt.input("Model ID"))
    : await prompt.select("Discovered model", discovery.models.map((model) => model.id)));
  const profileSlug = requiredAnswer(await prompt.input("Model profile slug", slugFor(modelId)));
  const profileName = requiredAnswer(await prompt.input("Model profile display name", modelId));
  const contextSource = await prompt.select("Context source", ["preset", "operator", "assumed_32768"] as const);
  const context = contextSource === "operator"
    ? { maxInputTokens: positiveInteger(await prompt.input("Maximum input tokens")), contextWindowSource: contextSource }
    : contextSource === "assumed_32768"
      ? { maxInputTokens: 32_768, contextWindowSource: contextSource }
      : {};
  const profile = await client.request<ProfileResponse>("/v1/admin/model-profiles", {
    authority: "admin",
    method: "POST",
    body: {
      slug: profileSlug,
      displayName: profileName,
      connectionRevisionId: connectionRevision.revisionId,
      ...(catalogCandidate === undefined
        ? {
            modelId,
            protocol: connectionRevision.protocolPreference,
          }
        : { catalogCandidateId: catalogCandidate.candidateId }),
      ...context,
      ...(manual ? { manualEntryAcknowledged: true } : {}),
    },
  });
  const profileRevision = profile.revisions.at(-1);
  if (profileRevision === undefined) throw new Error("invalid_control_plane_response");
  if (!await prompt.confirm(`Use resolved context limit of ${profileRevision.maxInputTokens} tokens from ${profileRevision.contextWindowSource}?`)) {
    writeSetupResult(write, json, { status: "cancelled", traceId: "cli" });
    return 0;
  }

  // 6. Queue and poll Verification through the control-plane operation URL.
  const queued = await client.request<{ readonly operationUrl: string }>(`/v1/admin/model-profile-revisions/${encodeURIComponent(profileRevision.revisionId)}/verifications`, {
    authority: "admin",
    method: "POST",
    body: { expectedRevision: profile.recordRevision, capabilityBaseline: "text_and_single_tool_call_v1" },
  });
  const verification = await pollVerification(
    client,
    queued.operationUrl,
    profileRevision.revisionId,
    sleep,
  );

  // 7. Resolve the optional post-promotion intent and visibly review every safety field.
  const makeDefault = await prompt.confirm("Make this model profile the default after Promotion?");
  const affectedAgents = parseAgents(await prompt.input("Agent IDs to bind after Promotion (comma-separated, blank for none)"));
  let currentProfile: ProfileResponse | undefined;
  let selectedProfileRevision = profileRevision;
  let defaultExpectedRevision: number | undefined;
  const assignmentExpectedRevisions = new Map<string, number>();
  if (
    verification.status === "passed" ||
    verification.profileRevisionId !== profileRevision.revisionId
  ) {
    currentProfile = await client.request<ProfileResponse>(`/v1/admin/model-profiles/${encodeURIComponent(profileSlug)}`, { authority: "admin" });
    const terminalCandidate = currentProfile.revisions.find((revision) =>
      revision.revisionId === verification.profileRevisionId
    );
    if (terminalCandidate === undefined) {
      throw new Error("invalid_control_plane_response");
    }
    selectedProfileRevision = terminalCandidate;
  }
  if (verification.status === "passed") {
    if (currentProfile === undefined) throw new Error("invalid_control_plane_response");
    if (makeDefault) {
      const currentDefault = await client.request<{ readonly recordRevision: number | null }>("/v1/admin/default-model-profile", { authority: "admin" });
      defaultExpectedRevision = currentDefault.recordRevision ?? 0;
    }
    for (const agentId of affectedAgents) {
      const assignment = await client.request<{ readonly recordRevision: number | null }>(`/v1/admin/agents/${encodeURIComponent(agentId)}/model-assignment`, { authority: "admin" });
      assignmentExpectedRevisions.set(agentId, assignment.recordRevision ?? 0);
    }
  }
  const review = reviewValue(
    connectionRevision.baseUrl,
    authMode,
    modelId,
    selectedProfileRevision,
    profileRevision.revisionId,
    verification,
    affectedAgents,
  );
  writeReview(write, json, review);
  if (verification.status === "cancelled") {
    writeSetupResult(write, json, { status: "cancelled", traceId: verification.traceId }, review);
    return 0;
  }
  if (verification.status !== "passed") {
    writeProblem(write, {
      code: verification.resultCode ?? "verification_failed",
      detail: "Model verification failed.",
      traceId: verification.traceId,
    }, json);
    return 5;
  }

  // 8. Promotion is the first point at which active state may change.
  const promote = await prompt.confirm("Promote the verified connection and model profile?");
  if (!promote) {
    writeSetupResult(write, json, { status: "cancelled", traceId: verification.traceId }, review);
    return 0;
  }
  if (currentProfile === undefined) throw new Error("invalid_control_plane_response");
  await client.request(`/v1/admin/provider-connections/${encodeURIComponent(slug)}/promotions`, {
    authority: "admin",
    method: "POST",
    body: { connectionRevisionId: connectionRevision.revisionId, expectedRevision: discovery.recordRevision },
  });
  await client.request(`/v1/admin/model-profiles/${encodeURIComponent(profileSlug)}/promotions`, {
    authority: "admin",
    method: "POST",
    body: {
      profileRevisionId: selectedProfileRevision.revisionId,
      expectedRevision: currentProfile.recordRevision,
    },
  });

  // 9. Default and Agent assignment mutations are separate and explicitly optional.
  if (makeDefault) {
    if (defaultExpectedRevision === undefined) throw new Error("invalid_control_plane_response");
    await client.request("/v1/admin/default-model-profile", {
      authority: "admin",
      method: "PUT",
      body: { profileId: profileSlug, expectedRevision: defaultExpectedRevision },
    });
  }
  for (const agentId of affectedAgents) {
    const expectedRevision = assignmentExpectedRevisions.get(agentId);
    if (expectedRevision === undefined) throw new Error("invalid_control_plane_response");
    await client.request(`/v1/admin/agents/${encodeURIComponent(agentId)}/model-assignment`, {
      authority: "admin",
      method: "PUT",
      body: {
        modelProfileRevisionId: selectedProfileRevision.revisionId,
        expectedRevision,
      },
    });
  }
  writeSetupResult(write, json, { status: "configured", profileId: profileSlug, traceId: verification.traceId }, review);
  return 0;
}

async function selectCatalogCandidate(
  catalog: ProviderDriverCatalogResponse,
  driverId: string,
  prompt: CliPrompt,
): Promise<ProviderDriverCatalogResponse["drivers"][number]["candidates"][number]> {
  const driver = catalog.drivers.find((entry) => entry.driverId === driverId);
  const candidates = driver?.candidates.filter(
    (candidate) => candidate.credentialSupport !== "unsupported",
  ) ?? [];
  if (candidates.length === 0) throw new Error("invalid_control_plane_response");
  const selected = await prompt.select(
    "Catalog model",
    candidates.map((candidate) => candidate.candidateId),
  );
  const candidate = candidates.find(
    (entry) => entry.candidateId === selected || entry.modelId === selected,
  );
  if (candidate === undefined) throw new Error("invalid_control_plane_response");
  return candidate;
}

export function createConsolePrompt(): CliPrompt {
  return {
    async select<T extends string>(message: string, choices: readonly T[]): Promise<T> {
      for (;;) {
        const answer = await visibleQuestion(`${message} (${choices.join("/")})`);
        const numeric = Number(answer);
        const selected = Number.isInteger(numeric) && numeric >= 1 ? choices[numeric - 1] : undefined;
        if (selected !== undefined) return selected;
        if (choices.includes(answer as T)) return answer as T;
      }
    },
    async input(message: string, initial?: string): Promise<string> {
      const answer = await visibleQuestion(initial === undefined ? message : `${message} [${initial}]`);
      return answer.length === 0 && initial !== undefined ? initial : answer;
    },
    async secret(message: string): Promise<string> {
      process.stderr.write(`${message}: `);
      const sink = new Writable({ write: (_chunk, _encoding, callback) => callback() });
      const reader = createInterface({ input: process.stdin, output: sink, terminal: true });
      try {
        return await reader.question("");
      } finally {
        reader.close();
        process.stderr.write("\n");
      }
    },
    async confirm(message: string): Promise<boolean> {
      const answer = (await visibleQuestion(`${message} [y/N]`)).toLowerCase();
      return answer === "y" || answer === "yes";
    },
  };
}

const presets = {
  openai: { baseUrl: "https://api.openai.com/v1", protocol: "responses" as const },
  deepseek: { baseUrl: "https://api.deepseek.com", protocol: "responses" as const },
  custom: { baseUrl: "", protocol: "chat_completions" as const },
};

async function visibleQuestion(message: string): Promise<string> {
  const reader = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await reader.question(`${message}: `);
  } finally {
    reader.close();
  }
}

function reviewValue(
  destination: string,
  auth: string,
  model: string,
  profile: ProfileResponse["revisions"][number],
  preferredProfileRevisionId: string,
  verification: VerificationView,
  affectedAgents: readonly string[],
) {
  const warnings = [
    ...(verification.resultCode === null
      ? []
      : [`${verification.resultCode}${verification.safeStatus == null ? "" : ` (HTTP ${verification.safeStatus})`}`]),
    ...(profile.revisionId === preferredProfileRevisionId
      ? []
      : [`Fallback candidate selected: ${profile.revisionId}`]),
  ];
  return {
    destination,
    auth,
    model,
    profileRevisionId: profile.revisionId,
    protocol: profile.invocationProtocol,
    capabilities: verification.capabilities,
    usage: verification.usage ?? null,
    contextSource: profile.contextWindowSource,
    affectedAgents,
    warnings,
  };
}

function writeReview(write: CliWrite, json: boolean, review: ReturnType<typeof reviewValue>): void {
  if (json) return;
  write(`Destination: ${review.destination}`);
  write(`Auth: ${review.auth}`);
  write(`Model: ${review.model}`);
  write(`Candidate revision: ${review.profileRevisionId}`);
  write(`Protocol: ${review.protocol}`);
  write(`Capabilities: ${review.capabilities.length === 0 ? "none" : review.capabilities.join(", ")}`);
  write(`Usage: ${review.usage === null ? "unavailable" : `${review.usage.inputTokens} input, ${review.usage.outputTokens} output`}`);
  write(`Context source: ${review.contextSource}`);
  write(`Affected Agents: ${review.affectedAgents.length === 0 ? "none" : review.affectedAgents.join(", ")}`);
  write(`Warnings: ${review.warnings.length === 0 ? "none" : review.warnings.join(", ")}`);
}

function writeSetupResult(
  write: CliWrite,
  json: boolean,
  value: Record<string, unknown>,
  review?: ReturnType<typeof reviewValue>,
): void {
  if (json) writeJson(write, review === undefined ? value : { ...value, review });
  else write(value.status === "cancelled" ? "Setup cancelled." : JSON.stringify(value));
}

function requiredAnswer(value: string): string {
  if (value.trim().length === 0) {
    throw new CliValidationError(
      "missing_interactive_value",
      "A required interactive value is missing.",
    );
  }
  return value.trim();
}

function positiveInteger(value: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new CliValidationError(
      "invalid_positive_integer",
      "A positive integer is required.",
    );
  }
  return parsed;
}

function parseAgents(value: string): string[] {
  return [...new Set(value.split(",").map((agent) => agent.trim()).filter((agent) => agent.length > 0))];
}

function slugFor(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_-]+/gu, "-").replace(/^-|-$/gu, "") || "model";
}

function title(value: string): string {
  return value === "openai" ? "OpenAI" : value === "deepseek" ? "DeepSeek" : "Custom";
}
