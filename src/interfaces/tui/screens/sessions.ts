import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

import { safeDisplayLines } from "../safe-display-text.js";
import type { TuiClient } from "../tui-client.js";

type SessionHistoryClient = Pick<TuiClient, "listSessions">;
type SessionRow = { readonly sessionId: string; readonly agentId: string; readonly sessionKey: string; readonly updatedAt: string };

export class SessionsScreen implements Component, Focusable {
  focused = false;
  private items: readonly SessionRow[] = [];
  private nextCursor: string | undefined;
  private selected = 0;
  private loading = false;
  constructor(private readonly options: { readonly client: SessionHistoryClient; readonly onRuns: (session: SessionRow) => void; readonly onChange?: () => void; readonly onExit?: () => void }) {}
  async load(next = false): Promise<void> {
    if (this.loading || (next && this.nextCursor === undefined)) return;
    this.loading = true; this.changed();
    try { const page = await this.options.client.listSessions({ limit: 50, ...(next && this.nextCursor !== undefined ? { cursor: this.nextCursor } : {}) }); this.items = next ? [...this.items, ...page.items] : page.items; this.nextCursor = page.nextCursor; this.selected = Math.min(this.selected, Math.max(0, this.items.length - 1)); }
    finally { this.loading = false; this.changed(); }
  }
  handleInput(data: string): void { if (matchesKey(data, "escape")) this.options.onExit?.(); else if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1); else if (matchesKey(data, "down")) this.selected = Math.min(this.items.length - 1, this.selected + 1); else if (matchesKey(data, "enter")) { const item = this.items[this.selected]; if (item !== undefined) this.options.onRuns(item); } else if (data === "r") void this.load(); else if (data === "n") void this.load(true); this.changed(); }
  render(width: number): string[] { return ["Sessions", ...(this.items.length === 0 ? [this.loading ? "Loading..." : "No Sessions found."] : this.items.map((item, index) => `${index === this.selected ? ">" : " "} ${item.agentId} ${item.sessionKey} ${item.sessionId} ${item.updatedAt}`)), "Run history is retained; Session deletion is unavailable.", ...(this.nextCursor === undefined ? [] : ["[n] next page"]), "[Enter] Runs  [r] reload  [Esc] navigation"].flatMap(safeDisplayLines).map((line) => truncateToWidth(line, width)); }
  invalidate(): void {} private changed(): void { this.options.onChange?.(); }
}
