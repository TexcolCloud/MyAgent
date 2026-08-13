import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import type { DiagnosticReport } from "../../../application/collect-diagnostics.js";
import { safeDisplayLines } from "../safe-display-text.js";
import type { TuiClient } from "../tui-client.js";

type DiagnosticClient = Pick<TuiClient, "getDiagnostics">;

export class DiagnosticsScreen implements Component, Focusable {
  focused = false;
  private report: DiagnosticReport | undefined;
  private loading = false;

  constructor(private readonly options: { readonly client: DiagnosticClient; readonly onChange?: () => void; readonly onExit?: () => void }) {}

  async load(): Promise<void> {
    if (this.loading) return;
    this.loading = true; this.changed();
    try { this.report = await this.options.client.getDiagnostics(); } finally { this.loading = false; this.changed(); }
  }

  handleInput(data: string): void {
    if (matchesKey(data, "escape")) this.options.onExit?.();
    if (data === "r") void this.load();
  }

  render(width: number): string[] {
    const lines = ["Diagnostics"];
    if (this.loading) lines.push("Loading...");
    else if (this.report === undefined) lines.push("Diagnostics unavailable.");
    else lines.push(...this.report.checks.map((check) => `${check.id}: ${check.status} (${check.detail})`));
    lines.push("[r] refresh  [Esc] navigation");
    return lines.flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width));
  }
  invalidate(): void {}
  private changed(): void { this.options.onChange?.(); }
}
