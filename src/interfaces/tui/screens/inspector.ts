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
