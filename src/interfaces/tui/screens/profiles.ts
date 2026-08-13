import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { CliPrompt } from "../../cli/commands/model-setup.js";
import type {
  CreateModelProfileInput,
  ProviderConnectionResponse,
  ModelProfileResponse,
} from "../../http/model-control-schemas.js";
import { safeDisplayLines } from "../safe-display-text.js";
import { isRevisionConflict, type TuiClient } from "../tui-client.js";
import type { InspectorScreen } from "./inspector.js";

type ProfileClient = Pick<TuiClient,
  "listModelProfiles" | "getModelProfile" | "createModelProfile" |
  "promoteModelProfile" | "retireModelProfile" | "listProviderConnections" |
  "getProviderConnection" | "listProviderDrivers"
>;

interface ProfileRow {
  readonly profileId: string;
  readonly displayName: string;
  readonly activeRevisionId: string | null;
  readonly retiredAt: string | null;
}

export class ProfileScreen implements Component, Focusable {
  focused = false;
  private rows: readonly ProfileRow[] = [];
  private selectedIndex = 0;
  private selectedDetail: ModelProfileResponse | undefined;
  private pending = false;
  private reloadRequired = false;
  private operation: Promise<unknown> | undefined;

  constructor(private readonly options: {
    readonly client: ProfileClient;
    readonly inspector: InspectorScreen;
    readonly promptFactory?: () => CliPrompt;
    readonly onChange?: () => void;
    readonly onExit?: () => void;
  }) {}

  async load(): Promise<void> { await this.runLoad(); }
  async settled(): Promise<void> { await this.operation; }

  handleInput(data: string): void {
    if (this.pending) return;
    if (matchesKey(data, "escape")) return this.options.onExit?.();
    if (this.reloadRequired) {
      if (data === "r") void this.load();
      return;
    }
    if (matchesKey(data, "up")) this.selectedIndex = Math.max(0, this.selectedIndex - 1);
    if (matchesKey(data, "down")) this.selectedIndex = Math.min(this.rows.length - 1, this.selectedIndex + 1);
    if (matchesKey(data, "enter")) void this.run(() => this.inspect());
    if (data === "n") void this.run(() => this.create());
    if (data === "p") void this.run(() => this.promote());
    if (data === "x") void this.run(() => this.retire());
    this.changed();
  }

  render(width: number): string[] {
    const lines = ["Profiles"];
    if (this.rows.length === 0) lines.push(this.pending ? "Loading..." : "No Model Profiles are available.");
    else lines.push(...this.rows.map((row, index) =>
      `${index === this.selectedIndex ? ">" : " "} ${row.displayName} (${row.profileId}) [${row.retiredAt === null ? "available" : "locked"}]`,
    ));
    lines.push(this.reloadRequired ? "Reload required. Press r." : "[Enter] detail  [n] new  [p] promote  [x] retire  [Esc] navigation");
    return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
  }

  invalidate(): void {}

  private async runLoad(): Promise<void> {
    if (this.operation !== undefined) return;
    this.pending = true;
    const operation = this.options.client.listModelProfiles().then((response) => {
      this.rows = response.profiles;
      this.selectedIndex = Math.min(this.selectedIndex, Math.max(0, this.rows.length - 1));
      this.selectedDetail = undefined;
      this.reloadRequired = false;
      this.options.inspector.clear();
    }).catch(() => this.options.inspector.showProblem({ code: "profile_list_failed", detail: "Model Profiles are unavailable.", traceId: "tui" }))
      .finally(() => { this.pending = false; if (this.operation === operation) this.operation = undefined; this.changed(); });
    this.operation = operation;
    await operation;
  }

  private async inspect(): Promise<void> {
    const detail = await this.requireSelected();
    this.options.inspector.showProfileDetail(profileDetail(detail));
  }

  private async create(): Promise<void> {
    const prompt = this.prompt();
    const slug = required(await prompt.input("Profile ID"));
    const displayName = required(await prompt.input("Profile display name"));
    const target = await this.selectProviderRevision(prompt);
    const input = await this.profileInput(prompt, slug, displayName, target);
    if (!await this.confirm("Profile creation", slug, "none", "new draft", [])) return;
    this.accept(await this.options.client.createModelProfile(input), "Created draft Profile.");
  }

  private async selectProviderRevision(prompt: CliPrompt): Promise<ProviderRevisionTarget> {
    const connections = await this.options.client.listProviderConnections();
    const details = await Promise.all(connections.connections.map(({ connectionId }) =>
      this.options.client.getProviderConnection(connectionId),
    ));
    const targets = details.flatMap(providerRevisionTargets);
    const revisionId = await prompt.select("Provider revision", targets.map(({ revisionId }) => revisionId));
    const target = targets.find((candidate) => candidate.revisionId === revisionId);
    if (target === undefined) throw new Error("provider_revision_not_selected");
    return target;
  }

  private async profileInput(
    prompt: CliPrompt,
    slug: string,
    displayName: string,
    target: ProviderRevisionTarget,
  ): Promise<CreateModelProfileInput> {
    if (target.providerKind !== "openai_compatible") {
      if (target.driverId === undefined) throw new Error("provider_driver_not_found");
      const catalog = await this.options.client.listProviderDrivers();
      const driver = catalog.drivers.find(({ driverId }) => driverId === target.driverId);
      if (driver === undefined) throw new Error("provider_driver_not_found");
      const catalogCandidateId = await prompt.select(
        "Catalog Candidate",
        driver.candidates.filter(({ credentialSupport }) => credentialSupport !== "unsupported")
          .map(({ candidateId }) => candidateId),
      );
      return { slug, displayName, connectionRevisionId: target.revisionId, catalogCandidateId };
    }
    const modelId = required(await prompt.input("Provider model ID"));
    const protocol = await prompt.select("Protocol", ["auto", "chat_completions", "responses"] as const);
    if (!await prompt.confirm("Acknowledge manual custom-provider model entry?")) throw new Error("manual_profile_not_acknowledged");
    return {
      slug,
      displayName,
      connectionRevisionId: target.revisionId,
      modelId,
      protocol,
      manualEntryAcknowledged: true,
    };
  }

  private async promote(): Promise<void> {
    const profile = await this.requireSelected();
    const candidates = profile.revisions.filter((revision) => revision.state === "verified" || revision.state === "legacy_trusted");
    if (candidates.length === 0) {
      this.options.inspector.showProblem({ code: "verification_required", detail: "Verification required before Promotion.", traceId: "tui" });
      return;
    }
    const prompt = this.prompt();
    const revisionId = await prompt.select("Profile revision", candidates.map(({ revisionId }) => revisionId));
    const revision = candidates.find((candidate) => candidate.revisionId === revisionId);
    if (revision === undefined) throw new Error("profile_revision_not_selected");
    if (!await this.confirm("Profile Promotion", profile.profileId, profile.activeRevisionId ?? "none", revisionId, revision.verifiedCapabilities)) return;
    const promoted = await this.options.client.promoteModelProfile(profile.profileId, { profileRevisionId: revisionId, expectedRevision: profile.recordRevision });
    this.selectedDetail = promoted;
    this.rows = this.rows.map((row) => row.profileId === promoted.profileId ? summary(promoted) : row);
    this.options.inspector.showProfileReview({ title: "Profile Promotion", profileId: profile.profileId, currentRevision: profile.activeRevisionId ?? "none", proposedRevision: revisionId, capabilities: revision.verifiedCapabilities, confirmation: "confirmed", outcome: "Profile promoted." });
  }

  private async retire(): Promise<void> {
    const profile = await this.requireSelected();
    if (!await this.confirm("Profile retirement", profile.profileId, profile.activeRevisionId ?? "none", "retired", [])) return;
    this.accept(await this.options.client.retireModelProfile(profile.profileId, { expectedRevision: profile.recordRevision }), "Profile retired; historical Runs remain unchanged.");
  }

  private async requireSelected(): Promise<ModelProfileResponse> {
    const row = this.rows[this.selectedIndex];
    if (row === undefined) throw new Error("profile_not_selected");
    const detail = this.selectedDetail?.profileId === row.profileId ? this.selectedDetail : await this.options.client.getModelProfile(row.profileId);
    this.selectedDetail = detail;
    return detail;
  }

  private async confirm(title: string, profileId: string, currentRevision: string, proposedRevision: string, capabilities: readonly string[]): Promise<boolean> {
    this.options.inspector.showProfileReview({ title, profileId, currentRevision, proposedRevision, capabilities, confirmation: "required" });
    this.changed();
    const confirmed = await this.prompt().confirm(`Confirm ${title}?`);
    if (!confirmed) this.options.inspector.showProfileReview({ title, profileId, currentRevision, proposedRevision, capabilities, confirmation: "declined", outcome: "No request sent." });
    return confirmed;
  }

  private accept(profile: ModelProfileResponse, outcome: string): void {
    this.selectedDetail = profile;
    this.rows = this.rows.some((row) => row.profileId === profile.profileId)
      ? this.rows.map((row) => row.profileId === profile.profileId ? summary(profile) : row)
      : [...this.rows, summary(profile)];
    this.options.inspector.showProfileDetail(profileDetail(profile, outcome));
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.operation !== undefined || this.reloadRequired) return;
    this.pending = true;
    const operation = action().catch((error: unknown) => {
      if (isRevisionConflict(error)) { this.reloadRequired = true; this.options.inspector.showConflict(); }
      else this.options.inspector.showProblem({ code: "profile_operation_failed", detail: "The Profile operation was not accepted.", traceId: "tui" });
    }).finally(() => { this.pending = false; if (this.operation === operation) this.operation = undefined; this.changed(); });
    this.operation = operation;
    await operation;
  }

  private prompt(): CliPrompt { const prompt = this.options.promptFactory?.(); if (prompt === undefined) throw new Error("profile_prompt_unavailable"); return prompt; }
  private changed(): void { this.options.onChange?.(); }
}

function summary(profile: ModelProfileResponse): ProfileRow { return { profileId: profile.profileId, displayName: profile.displayName, activeRevisionId: profile.activeRevisionId, retiredAt: profile.retiredAt }; }
function profileDetail(profile: ModelProfileResponse, outcome?: string) { const latest = profile.revisions.at(-1); return { profileId: profile.profileId, displayName: profile.displayName, recordRevision: profile.recordRevision, activeRevisionId: profile.activeRevisionId, latestRevisionId: latest?.revisionId ?? null, latestRevisionState: latest?.state ?? "missing", capabilities: latest?.verifiedCapabilities ?? [], retiredAt: profile.retiredAt, ...(outcome === undefined ? {} : { outcome }) }; }
function required(value: string): string { const normalized = value.trim(); if (normalized.length === 0) throw new Error("profile_value_required"); return normalized; }

interface ProviderRevisionTarget {
  readonly revisionId: string;
  readonly providerKind: ProviderConnectionResponse["providerKind"];
  readonly driverId: string | undefined;
}

function providerRevisionTargets(connection: ProviderConnectionResponse): readonly ProviderRevisionTarget[] {
  return connection.revisions.map(({ revisionId }) => ({
    revisionId,
    providerKind: connection.providerKind,
    driverId: connection.providerDriver,
  }));
}
