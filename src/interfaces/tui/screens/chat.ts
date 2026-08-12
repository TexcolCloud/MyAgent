import { truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { WorkbenchDestination } from "./navigation.js";

export class ChatScreen implements Component, Focusable {
  focused = false;
  private destination: WorkbenchDestination = "runs";

  show(destination: WorkbenchDestination): void { this.destination = destination; }

  render(width: number): string[] {
    const title = this.destination === "runs" ? "Runs" : titleFor(this.destination);
    return [
      truncateToWidth(title, width),
      truncateToWidth("No active work is selected.", width),
    ];
  }

  invalidate(): void {}
}

function titleFor(destination: Exclude<WorkbenchDestination, "runs">): string {
  return destination[0]!.toUpperCase() + destination.slice(1);
}
