import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { CliPrompt } from "../../cli/commands/model-setup.js";
import type {
  CreateProviderConnectionInput,
  ProviderConnectionResponse,
  ReviseProviderConnectionInput,
} from "../../http/model-control-schemas.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type TuiClient } from "../tui-client.js";
import type { InspectorScreen, ProviderReviewView } from "./inspector.js";

type ProviderClient = Pick<TuiClient,
  "listProviderConnections" | "getProviderConnection" | "createProvider" |
  "reviseProvider" | "discoverProviderModels" | "getProviderModels" |
  "promoteProvider" | "retireProvider" | "listProviderDrivers" |
  "listModelProfiles" | "getModelProfile"
>;

interface ProviderRow {
  readonly connectionId: string;
  readonly displayName: string;
  readonly activeRevisionId: string | null;
  readonly retiredAt: string | null;
}

interface CatalogCandidate {
  readonly candidateId: string;
  readonly displayName: string;
  readonly modelId: string;
  readonly driverId: string;
  readonly credentialSupport: "bearer" | "none" | "unsupported";
}

export class ProviderScreen implements Component, Focusable {
  focused = false;
  private rows: readonly ProviderRow[] = [];
  private candidates: readonly CatalogCandidate[] = [];
  private selectedIndex = 0;
  private selectedDetail: ProviderConnectionResponse | undefined;
  private affectedProfiles: readonly string[] = [];
  private pending = false;
  private reloadRequired = false;
  private promotionLocked = false;
  private operation: Promise<unknown> | undefined;

  constructor(private readonly options: {
    readonly client: ProviderClient;
    readonly inspector: InspectorScreen;
    readonly promptFactory?: () => CliPrompt;
    readonly onChange?: () => void;
    readonly onExit?: () => void;
  }) {}

  async load(): Promise<void> {
    if (this.operation !== undefined) return;
    const operation = this.loadAll();
    this.operation = operation;
    try { await operation; } finally {
      if (this.operation === operation) this.operation = undefined;
    }
  }

  async settled(): Promise<void> { await this.operation; }

  handleInput(data: string): void {
    if (this.pending) return;
    if (matchesKey(data, "escape")) {
      this.options.onExit?.();
      return;
    }
    if (this.reloadRequired) {
      if (matchesKey(data, "r")) void this.load();
      return;
    }
    if (matchesKey(data, "up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (matchesKey(data, "down")) this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
    if (matchesKey(data, "enter")) void this.selectCurrent();
    if (data === "n") void this.runMutation(() => this.create());
    if (data === "e") void this.runMutation(() => this.revise());
    if (data === "d") void this.runMutation(() => this.discover());
    if (data === "p" && !this.promotionLocked) void this.runMutation(() => this.promote());
    if (data === "x") void this.runMutation(() => this.retire());
    this.changed();
  }

  render(width: number): string[] {
    const lines = ["Providers"];
    if (this.rows.length === 0) lines.push(this.pending ? "Loading..." : "No Provider Connections are available.");
    else lines.push(...this.rows.map((row, index) => {
      const status = row.retiredAt === null ? "available" : "locked";
      return `${index === this.selectedIndex ? ">" : " "} ${row.displayName} (${row.connectionId}) [${status}]`;
    }));
    lines.push(...this.candidates.map((candidate) =>
      `Catalog Candidate: ${candidate.displayName} (${candidate.modelId}) [${candidate.driverId}]`,
    ));
    if (this.reloadRequired) lines.push("Reload required. Press r.");
    else {
      if (this.promotionLocked) lines.push("Promotion locked: remote discovery must succeed.");
      lines.push("[Enter] detail  [n] new  [e] revise  [d] discover  [p] promote  [x] retire  [Esc] navigation");
    }
    return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private async loadAll(): Promise<void> {
    this.pending = true;
    this.selectedDetail = undefined;
    this.affectedProfiles = [];
    this.promotionLocked = false;
    this.changed();
    try {
      const [connections, catalog] = await Promise.all([
        this.options.client.listProviderConnections(),
        this.options.client.listProviderDrivers(),
      ]);
      this.rows = connections.connections;
      this.candidates = catalog.drivers.flatMap((driver) => driver.candidates.map((candidate) => ({
        ...candidate,
        driverId: driver.driverId,
      })));
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
      this.reloadRequired = false;
      this.options.inspector.clear();
    } catch {
      this.options.inspector.showProblem({
        code: "provider_list_failed",
        detail: "Provider Connections are unavailable.",
        traceId: "tui",
      });
    } finally {
      this.pending = false;
      this.changed();
    }
  }

  private async selectCurrent(): Promise<void> {
    const row = this.rows[this.selectedIndex];
    if (row === undefined) return;
    await this.run(async () => {
      const detail = await this.options.client.getProviderConnection(row.connectionId);
      const latest = detail.revisions.at(-1);
      const discovery = latest === undefined
        ? undefined
        : await this.options.client.getProviderModels(latest.revisionId);
      const profiles = await this.options.client.listModelProfiles();
      const profileDetails = await Promise.all(profiles.profiles.map((profile) =>
        this.options.client.getModelProfile(profile.profileId),
      ));
      this.selectedDetail = detail;
      this.affectedProfiles = affectedProfileIds(detail, profileDetails);
      this.promotionLocked = discovery?.state === "failed" || discovery?.state === "stale";
      this.options.inspector.showProviderDetail({
        connectionId: detail.connectionId,
        displayName: detail.displayName,
        recordRevision: detail.recordRevision,
        activeRevisionId: detail.activeRevisionId,
        latestRevisionId: latest?.revisionId ?? null,
        latestRevisionState: latest?.state ?? "missing",
        health: providerHealth(detail, discovery?.state),
        status: detail.retiredAt === null ? "available" : "locked",
        secretReference: secretStatus(detail),
        remoteDiscovery: discovery?.state ?? "unavailable",
        affectedProfiles: this.affectedProfiles,
      });
    });
  }

  private async create(): Promise<void> {
    const prompt = this.prompt();
    const driverId = await prompt.select("Provider Driver", this.candidates.length === 0
      ? ["pi/openai-compatible"] as const
      : [...new Set(this.candidates.map(({ driverId }) => driverId))]);
    const slug = required(await prompt.input("Provider ID"));
    const displayName = required(await prompt.input("Provider display name"));
    const baseUrl = required(await prompt.input("Base URL"));
    const credential = await collectCredential(prompt, false);
    const protocolPreference = await prompt.select("Protocol", ["responses", "chat_completions"] as const);
    const input: CreateProviderConnectionInput = {
      slug,
      displayName,
      driverId,
      baseUrl,
      ...credential,
      protocolPreference,
    };
    const changeReview = makeReview(slug, "none", "new draft", [], credentialLabel(input));
    if (!await this.confirm(prompt, changeReview)) return;
    const created = await this.options.client.createProvider(input);
    this.accept(created, changeReview);
  }

  private async revise(): Promise<void> {
    const current = await this.requireSelected();
    const latest = current.revisions.at(-1);
    if (latest === undefined) throw new Error("provider_revision_missing");
    const prompt = this.prompt();
    const displayName = required(await prompt.input("Provider display name", current.displayName));
    const baseUrl = required(await prompt.input("Base URL", latest.baseUrl));
    const credential = await collectCredential(prompt, latest.secretVersionId !== undefined, latest.secretVersionId);
    const protocolPreference = await prompt.select("Protocol", ["responses", "chat_completions"] as const);
    const input: ReviseProviderConnectionInput = {
      expectedRevision: current.recordRevision,
      displayName,
      baseUrl,
      ...credential,
      allowInsecureHttp: latest.allowInsecureHttp,
      protocolPreference,
      ...(current.providerDriver === undefined ? {} : { driverId: current.providerDriver }),
    };
    const changeReview = makeReview(current.connectionId, latest.revisionId, "new draft", this.affectedProfiles, credentialLabel(input));
    if (!await this.confirm(prompt, changeReview)) return;
    this.accept(await this.options.client.reviseProvider(current.connectionId, input), changeReview);
  }

  private async discover(): Promise<void> {
    const current = await this.requireSelected();
    const latest = current.revisions.at(-1);
    if (latest === undefined) throw new Error("provider_revision_missing");
    const prompt = this.prompt();
    const changeReview = makeReview(current.connectionId, latest.revisionId, "remote discovery refresh", this.affectedProfiles, secretStatus(current));
    if (!await this.confirm(prompt, changeReview)) return;
    const result = await this.options.client.discoverProviderModels(latest.revisionId, {
      expectedRevision: current.recordRevision,
    });
    this.promotionLocked = result.state === "failed" || result.state === "stale";
    this.options.inspector.showProviderReview({ ...changeReview, confirmation: "confirmed", outcome: `Remote discovery: ${result.state}` });
    this.selectedDetail = { ...current, recordRevision: result.recordRevision };
  }

  private async promote(): Promise<void> {
    const current = await this.requireSelected();
    const candidates = current.revisions.filter(({ state }) => state === "verified" || state === "legacy_trusted");
    if (candidates.length === 0) throw new Error("verified_provider_revision_missing");
    const prompt = this.prompt();
    const revisionId = await prompt.select("Provider revision", candidates.map(({ revisionId }) => revisionId));
    const changeReview = makeReview(current.connectionId, current.activeRevisionId ?? "none", revisionId, this.affectedProfiles, secretStatus(current));
    if (!await this.confirm(prompt, changeReview)) return;
    this.accept(await this.options.client.promoteProvider(current.connectionId, {
      connectionRevisionId: revisionId,
      expectedRevision: current.recordRevision,
    }), changeReview);
  }

  private async retire(): Promise<void> {
    const current = await this.requireSelected();
    const prompt = this.prompt();
    const reviewValue = makeReview(current.connectionId, current.activeRevisionId ?? "none", "retired", this.affectedProfiles, secretStatus(current));
    if (!await this.confirm(prompt, reviewValue)) return;
    this.accept(await this.options.client.retireProvider(current.connectionId, {
      expectedRevision: current.recordRevision,
    }), reviewValue);
  }

  private async requireSelected(): Promise<ProviderConnectionResponse> {
    const row = this.rows[this.selectedIndex];
    if (row === undefined) throw new Error("provider_not_selected");
    const current = this.selectedDetail?.connectionId === row.connectionId
      ? this.selectedDetail
      : await this.options.client.getProviderConnection(row.connectionId);
    const profiles = await this.options.client.listModelProfiles();
    const details = await Promise.all(profiles.profiles.map((profile) => this.options.client.getModelProfile(profile.profileId)));
    this.selectedDetail = current;
    this.affectedProfiles = affectedProfileIds(current, details);
    return current;
  }

  private async confirm(prompt: CliPrompt, value: ProviderReviewView): Promise<boolean> {
    this.options.inspector.showProviderReview(value);
    this.changed();
    const confirmed = await prompt.confirm(`Confirm Provider change for ${value.resourceId}?`);
    if (!confirmed) {
      this.options.inspector.showProviderReview({ ...value, confirmation: "declined", outcome: "No request sent." });
      this.changed();
    }
    return confirmed;
  }

  private accept(connection: ProviderConnectionResponse, confirmedReview: ProviderReviewView): void {
    this.selectedDetail = connection;
    this.rows = this.rows.some(({ connectionId }) => connectionId === connection.connectionId)
      ? this.rows.map((row) => row.connectionId === connection.connectionId ? summary(connection) : row)
      : [...this.rows, summary(connection)];
    const latest = connection.revisions.at(-1);
    this.options.inspector.showProviderReview({
      ...confirmedReview,
      confirmation: "confirmed",
      outcome: `Server revision: ${String(connection.recordRevision)}${latest === undefined ? "" : `; latest ${latest.revisionId}`}`,
    });
  }

  private runMutation(action: () => Promise<void>): Promise<void> {
    return this.run(action);
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.operation !== undefined || this.reloadRequired) return;
    this.pending = true;
    const operation = action().catch((error: unknown) => {
      if (isRevisionConflict(error)) {
        this.reloadRequired = true;
        this.options.inspector.showConflict();
      } else {
        this.options.inspector.showProblem({
          code: "provider_operation_failed",
          detail: "The Provider operation was not accepted.",
          traceId: "tui",
        });
      }
    }).finally(() => {
      this.pending = false;
      if (this.operation === operation) this.operation = undefined;
      this.changed();
    });
    this.operation = operation;
    await operation;
  }

  private prompt(): CliPrompt {
    const prompt = this.options.promptFactory?.();
    if (prompt === undefined) throw new Error("provider_prompt_unavailable");
    return prompt;
  }

  private changed(): void { this.options.onChange?.(); }
}

async function collectCredential(
  prompt: CliPrompt,
  canReuseManaged: boolean,
  secretVersionId?: string,
): Promise<Pick<CreateProviderConnectionInput, "auth" | "apiKey"> | { readonly auth: CreateProviderConnectionInput["auth"] }> {
  const choices = canReuseManaged
    ? ["existing", "environment", "managed_secret", "none"] as const
    : ["environment", "managed_secret", "none"] as const;
  const mode = await prompt.select("Provider credential", choices);
  if (mode === "existing") {
    if (secretVersionId === undefined) throw new Error("provider_secret_reference_missing");
    return { auth: { type: "managed_secret", secretVersionId } };
  }
  if (mode === "environment") {
    return { auth: { type: "environment", fromEnvironment: required(await prompt.input("Environment reference name")) } };
  }
  if (mode === "managed_secret") {
    let plaintext: string | undefined = required(await prompt.secret("API key"));
    const input = { auth: { type: "api_key" as const }, apiKey: plaintext };
    plaintext = undefined;
    return input;
  }
  return { auth: { type: "none" } };
}

function affectedProfileIds(
  connection: ProviderConnectionResponse,
  profiles: readonly Awaited<ReturnType<ProviderClient["getModelProfile"]>>[],
): readonly string[] {
  const revisions = new Set(connection.revisions.map(({ revisionId }) => revisionId));
  return profiles
    .filter((profile) => profile.revisions.some(({ connectionRevisionId }) => revisions.has(connectionRevisionId)))
    .map(({ profileId }) => profileId);
}

function makeReview(
  resourceId: string,
  currentRevision: string,
  proposedRevision: string,
  affectedProfiles: readonly string[],
  secretReference: string,
): ProviderReviewView {
  return {
    resourceId,
    currentRevision,
    proposedRevision,
    affectedProfiles,
    secretReference,
    confirmation: "required",
  };
}

function providerHealth(connection: ProviderConnectionResponse, discoveryState: string | undefined): "healthy" | "degraded" {
  const latest = connection.revisions.at(-1);
  return latest?.state === "failed" || discoveryState === "failed" || discoveryState === "stale"
    ? "degraded"
    : "healthy";
}

function secretStatus(connection: ProviderConnectionResponse): string {
  if (!connection.credentialConfigured) return "none";
  return connection.secretVersionId === undefined
    ? "environment reference configured"
    : "managed Secret configured";
}

function credentialLabel(input: { readonly auth: CreateProviderConnectionInput["auth"] }): string {
  if (input.auth.type === "api_key") return "managed Secret input (masked)";
  if (input.auth.type === "environment") return "environment reference configured";
  if (input.auth.type === "managed_secret") return "managed Secret configured";
  return "none";
}

function summary(connection: ProviderConnectionResponse): ProviderRow {
  return {
    connectionId: connection.connectionId,
    displayName: connection.displayName,
    activeRevisionId: connection.activeRevisionId,
    retiredAt: connection.retiredAt,
  };
}

function required(value: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error("provider_value_required");
  return normalized;
}
