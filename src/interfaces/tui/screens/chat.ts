import { truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { WorkbenchDestination } from "./navigation.js";

export class ChatScreen implements Component, Focusable {
  focused = false;
  private destination: WorkbenchDestination = "runs";
  private lines: readonly string[] = ["No active Run is selected."];

  show(destination: WorkbenchDestination, lines?: readonly string[]): void {
    this.destination = destination;
    this.lines = lines ?? noSelection(destination);
  }

  render(width: number): string[] {
    const title = this.destination === "runs" ? "Runs" : titleFor(this.destination);
    return [
      truncateToWidth(title, width),
      ...this.lines.map((line) => truncateToWidth(line, width)),
    ];
  }

  invalidate(): void {}
}

function noSelection(destination: WorkbenchDestination): readonly string[] {
  if (destination === "runs") return ["No active Run is selected."];
  if (destination === "verifications") return ["No Verification is selected."];
  return ["No entries are available."];
}

function titleFor(destination: Exclude<WorkbenchDestination, "runs">): string {
  return destination[0]!.toUpperCase() + destination.slice(1);
}
