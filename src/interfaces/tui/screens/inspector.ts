import { truncateToWidth, type Component } from "@mariozechner/pi-tui";

import { safeDisplayLines } from "../safe-display-text.js";

export interface SafeProblemView {
  readonly code: string;
  readonly detail: string;
  readonly traceId: string;
}

export type SafeInspectorView =
  | { readonly kind: "empty" }
  | { readonly kind: "conflict" }
  | { readonly kind: "provider_detail"; readonly detail: ProviderDetailView }
  | { readonly kind: "provider_review"; readonly review: ProviderReviewView }
  | { readonly kind: "profile_detail"; readonly detail: ProfileDetailView }
  | { readonly kind: "profile_review"; readonly review: ProfileReviewView }
  | { readonly kind: "verification"; readonly verification: VerificationView }
  | { readonly kind: "assignment"; readonly assignment: AssignmentView }
  | { readonly kind: "problem"; readonly problem: SafeProblemView };

export interface ProviderDetailView {
  readonly connectionId: string;
  readonly displayName: string;
  readonly recordRevision: number;
  readonly activeRevisionId: string | null;
  readonly latestRevisionId: string | null;
  readonly latestRevisionState: string;
  readonly health: "healthy" | "degraded";
  readonly status: "available" | "locked";
  readonly secretReference: string;
  readonly remoteDiscovery: string;
  readonly affectedProfiles: readonly string[];
}

export interface ProviderReviewView {
  readonly resourceId: string;
  readonly currentRevision: string;
  readonly proposedRevision: string;
  readonly affectedProfiles: readonly string[];
  readonly secretReference: string;
  readonly confirmation: "required" | "confirmed" | "declined";
  readonly outcome?: string;
}

export interface ProfileDetailView { readonly profileId: string; readonly displayName: string; readonly recordRevision: number; readonly activeRevisionId: string | null; readonly latestRevisionId: string | null; readonly latestRevisionState: string; readonly capabilities: readonly string[]; readonly retiredAt: string | null; readonly outcome?: string; }
export interface ProfileReviewView { readonly title: string; readonly profileId: string; readonly currentRevision: string; readonly proposedRevision: string; readonly capabilities: readonly string[]; readonly confirmation: "required" | "confirmed" | "declined"; readonly outcome?: string; }
export interface VerificationView { readonly verificationId: string; readonly profileRevisionId: string; readonly status: string; readonly capabilities: readonly string[]; readonly confirmation: "required" | "confirmed" | "declined"; }
export interface AssignmentView { readonly agentId: string; readonly profileRevisionId: string; readonly source: string; readonly confirmation: "required" | "confirmed" | "declined"; readonly outcome?: string; }

export class InspectorScreen implements Component {
  private view: SafeInspectorView = { kind: "empty" };

  showProblem(problem: SafeProblemView): void {
    this.view = {
      kind: "problem",
      problem: {
        code: clean(problem.code),
        detail: clean(problem.detail),
        traceId: clean(problem.traceId),
      },
    };
  }

  clear(): void { this.view = { kind: "empty" }; }

  showConflict(): void { this.view = { kind: "conflict" }; }

  showProviderDetail(detail: ProviderDetailView): void {
    this.view = { kind: "provider_detail", detail: cleanObject(detail) };
  }

  showProviderReview(review: ProviderReviewView): void {
    this.view = { kind: "provider_review", review: cleanObject(review) };
  }
  showProfileDetail(detail: ProfileDetailView): void { this.view = { kind: "profile_detail", detail: cleanObject(detail) }; }
  showProfileReview(review: ProfileReviewView): void { this.view = { kind: "profile_review", review: cleanObject(review) }; }
  showVerification(verification: VerificationView): void { this.view = { kind: "verification", verification: cleanObject(verification) }; }
  showAssignmentReview(assignment: AssignmentView): void { this.view = { kind: "assignment", assignment: cleanObject(assignment) }; }
  showAssignmentSummary(summary: { readonly agents: number; readonly defaultProfileId: string | null }): void { this.view = { kind: "assignment", assignment: { agentId: "summary", profileRevisionId: summary.defaultProfileId ?? "unset", source: "default", confirmation: "confirmed" } }; }

  render(width: number): string[] {
    if (this.view.kind === "empty") {
      return [truncateToWidth("Inspect", width), truncateToWidth("Select an item to inspect.", width)];
    }
    if (this.view.kind === "conflict") {
      return [
        truncateToWidth("Inspect", width),
        truncateToWidth("Reload required", width),
        truncateToWidth("Fetch current registry state before choosing again.", width),
      ];
    }
    if (this.view.kind === "provider_detail") {
      const detail = this.view.detail;
      return safeLines([
        "Inspect",
        `Provider ${detail.connectionId}`,
        detail.displayName,
        `Record revision: ${String(detail.recordRevision)}`,
        `Active revision: ${detail.activeRevisionId ?? "none"}`,
        `Latest revision: ${detail.latestRevisionId ?? "none"} (${detail.latestRevisionState})`,
        `Health: ${detail.health}`,
        `Status: ${detail.status}`,
        `Secret reference: ${detail.secretReference}`,
        `Remote discovery: ${detail.remoteDiscovery}`,
        `Affected Profiles: ${detail.affectedProfiles.length === 0 ? "none" : detail.affectedProfiles.join(", ")}`,
      ], width);
    }
    if (this.view.kind === "provider_review") {
      const review = this.view.review;
      return safeLines([
        "Inspect",
        "Provider change review",
        `ID: ${review.resourceId}`,
        `Current revision: ${review.currentRevision}`,
        `Proposed revision: ${review.proposedRevision}`,
        `Affected Profiles: ${review.affectedProfiles.length === 0 ? "none" : review.affectedProfiles.join(", ")}`,
        `Secret reference: ${review.secretReference}`,
        `Confirmation: ${review.confirmation}`,
        ...(review.outcome === undefined ? [] : [review.outcome]),
      ], width);
    }
    if (this.view.kind === "profile_detail") { const detail = this.view.detail; return safeLines(["Inspect", `Profile ${detail.profileId}`, detail.displayName, `Record revision: ${String(detail.recordRevision)}`, `Active revision: ${detail.activeRevisionId ?? "none"}`, `Latest revision: ${detail.latestRevisionId ?? "none"} (${detail.latestRevisionState})`, `Capabilities: ${detail.capabilities.length === 0 ? "none" : detail.capabilities.join(", ")}`, `Status: ${detail.retiredAt === null ? "available" : "locked"}`, ...(detail.outcome === undefined ? [] : [detail.outcome])], width); }
    if (this.view.kind === "profile_review") { const review = this.view.review; return safeLines(["Inspect", review.title, `Profile: ${review.profileId}`, `Current revision: ${review.currentRevision}`, `Proposed revision: ${review.proposedRevision}`, `Capabilities: ${review.capabilities.length === 0 ? "none" : review.capabilities.join(", ")}`, `Confirmation: ${review.confirmation}`, ...(review.outcome === undefined ? [] : [review.outcome])], width); }
    if (this.view.kind === "verification") { const verification = this.view.verification; return safeLines(["Inspect", `Verification ${verification.verificationId}`, `Profile revision: ${verification.profileRevisionId}`, `Status: ${verification.status}`, `Capabilities: ${verification.capabilities.length === 0 ? "none" : verification.capabilities.join(", ")}`, `Confirmation: ${verification.confirmation}`], width); }
    if (this.view.kind === "assignment") { const assignment = this.view.assignment; return safeLines(["Inspect", "Assignment review", `Agent: ${assignment.agentId}`, `Profile revision: ${assignment.profileRevisionId}`, `Source: ${assignment.source}`, `Confirmation: ${assignment.confirmation}`, ...(assignment.outcome === undefined ? [] : [assignment.outcome])], width); }
    const { code, detail, traceId } = this.view.problem;
    return [
      truncateToWidth("Inspect", width),
      truncateToWidth(code || "service_unavailable", width),
      truncateToWidth(detail || "The selected item is unavailable.", width),
      truncateToWidth(`trace: ${traceId || "tui"}`, width),
    ];
  }

  invalidate(): void {}
}

function cleanObject<Value>(value: Value): Value {
  if (typeof value === "string") return clean(value) as Value;
  if (Array.isArray(value)) return value.map(cleanObject) as Value;
  if (typeof value !== "object" || value === null) return value;
  return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, cleanObject(nested)])) as Value;
}

function safeLines(lines: readonly string[], width: number): string[] {
  return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
}

function clean(value: string): string {
  return safeDisplayLines(value).join(" ");
}
