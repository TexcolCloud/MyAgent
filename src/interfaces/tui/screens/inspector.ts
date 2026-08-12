import { truncateToWidth, type Component } from "@mariozechner/pi-tui";

export interface SafeProblemView {
  readonly code: string;
  readonly detail: string;
  readonly traceId: string;
}

export type SafeInspectorView =
  | { readonly kind: "empty" }
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

  render(width: number): string[] {
    if (this.view.kind === "empty") {
      return [truncateToWidth("Inspect", width), truncateToWidth("Select an item to inspect.", width)];
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
  return [...value]
    .filter((character) => {
      const code = character.codePointAt(0)!;
      return code >= 0x20 && (code < 0x7f || code > 0x9f);
    })
    .join("")
    .split(/\r?\n/u)
    .filter((line) => !/(authorization|bearer\s+\S+|api[_ -]?key|token)/iu.test(line))
    .join(" ")
    .trim();
}
