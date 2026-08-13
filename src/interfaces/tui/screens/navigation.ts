import { matchesKey, truncateToWidth, type Component, type Focusable } from "@mariozechner/pi-tui";

export type WorkbenchDestination = "agents" | "runs" | "sessions" | "providers" | "profiles" | "verifications" | "diagnostics";

const destinations: readonly { readonly id: WorkbenchDestination; readonly label: string }[] = [
  { id: "agents", label: "Agents" },
  { id: "runs", label: "Runs" },
  { id: "providers", label: "Providers" },
  { id: "profiles", label: "Profiles" },
  { id: "verifications", label: "Verifications" },
  { id: "sessions", label: "Sessions" },
  { id: "diagnostics", label: "Diagnostics" },
];

export class NavigationScreen implements Component, Focusable {
  focused = false;
  private selected = 1;

  constructor(private readonly onNavigate: (destination: WorkbenchDestination) => void) {}

  handleInput(data: string): void {
    if (matchesKey(data, "up")) this.selected = Math.max(0, this.selected - 1);
    if (matchesKey(data, "down")) this.selected = Math.min(destinations.length - 1, this.selected + 1);
    if (matchesKey(data, "enter")) this.onNavigate(destinations[this.selected]!.id);
  }

  render(width: number): string[] {
    return [
      truncateToWidth("Navigation", width),
      ...destinations.map((destination, index) => truncateToWidth(
        `${index === this.selected ? ">" : " "} ${destination.label}`,
        width,
      )),
    ];
  }

  invalidate(): void {}
}
