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
  return value
    .split(/\r?\n/u)
    .map(stripControls)
    .filter((line) => !/(authorization|bearer\s+\S+|api[_ -]?key|token)/iu.test(line))
    .join(" ")
    .trim();
}

function stripControls(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]!;
    const code = character.charCodeAt(0);
    if (code === 0x1b) {
      const next = value[index + 1];
      if (next === "[") {
        index += 2;
        while (index < value.length && !isAnsiTerminator(value[index]!)) index += 1;
      } else if (next === "]") {
        index += 2;
        while (index < value.length && value[index] !== "\u0007") index += 1;
      }
      continue;
    }
    if (code >= 0x20 && (code < 0x7f || code > 0x9f)) result += character;
  }
  return result;
}

function isAnsiTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}
