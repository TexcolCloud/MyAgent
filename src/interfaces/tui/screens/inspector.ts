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
  | { readonly kind: "problem"; readonly problem: SafeProblemView };

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

function clean(value: string): string {
  return safeDisplayLines(value).join(" ");
}
