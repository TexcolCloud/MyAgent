import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import { safeDisplayLines } from "../safe-display-text.js";
import type { TuiClient } from "../tui-client.js";

type SessionHistoryClient = Pick<TuiClient, "listSessions">;

export class SessionsScreen implements Component, Focusable {
  focused = false;
  private items: readonly { readonly sessionId: string; readonly agentId: string; readonly sessionKey: string; readonly updatedAt: string }[] = [];
  private nextCursor: string | undefined;
  private loading = false;

  constructor(private readonly options: { readonly client: SessionHistoryClient; readonly onChange?: () => void; readonly onExit?: () => void }) {}

  async load(next = false): Promise<void> {
    if (this.loading || (next && this.nextCursor === undefined)) return;
    this.loading = true; this.changed();
    try {
      const page = await this.options.client.listSessions({ limit: 50, ...(next && this.nextCursor !== undefined ? { cursor: this.nextCursor } : {}) });
      this.items = next ? [...this.items, ...page.items] : page.items;
      this.nextCursor = page.nextCursor;
    } finally { this.loading = false; this.changed(); }
  }

  handleInput(data: string): void { if (matchesKey(data, "escape")) this.options.onExit?.(); else if (data === "r") void this.load(); else if (data === "n") void this.load(true); }
  render(width: number): string[] { return ["Sessions", ...(this.items.length === 0 ? [this.loading ? "Loading..." : "No Sessions found."] : this.items.map((item) => `${item.agentId} ${item.sessionKey} ${item.sessionId} ${item.updatedAt}`)), "Run history is retained; Session deletion is unavailable.", ...(this.nextCursor === undefined ? [] : ["[n] next page"]), "[r] reload  [Esc] navigation"].flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width)); }
  invalidate(): void {}
  private changed(): void { this.options.onChange?.(); }
}
