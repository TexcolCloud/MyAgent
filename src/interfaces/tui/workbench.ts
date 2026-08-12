import {
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal,
} from "@mariozechner/pi-tui";

import { ChatScreen } from "./screens/chat.js";
import { InspectorScreen } from "./screens/inspector.js";
import { NavigationScreen } from "./screens/navigation.js";
import type { TuiClient } from "./tui-client.js";

export interface RunWorkbenchOptions {
  readonly client: Pick<TuiClient, "listProviderDrivers">;
  readonly terminal?: Terminal;
}

export async function runWorkbench(options: RunWorkbenchOptions): Promise<void> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const inspector = new InspectorScreen();
  const chat = new ChatScreen();
  const navigation = new NavigationScreen((destination) => {
    chat.show(destination);
    inspector.clear();
    tui.requestRender();
  });
  const layout = new WorkbenchLayout(navigation, chat, inspector);
  tui.addChild(layout);
  tui.setFocus(chat);

  let closed = false;
  let finish: (() => void) | undefined;
  const close = () => {
    if (closed) return;
    closed = true;
    tui.stop();
    finish?.();
  };

  const done = new Promise<void>((resolve) => { finish = resolve; });
  tui.addInputListener((data) => {
    if (!matchesKey(data, "ctrl+c")) return undefined;
    if (tui.hasOverlay()) tui.hideOverlay();
    close();
    return { consume: true };
  });
  tui.start();
  tui.requestRender(true);

  void options.client.listProviderDrivers().then(
    () => undefined,
    () => {
      inspector.showProblem({
        code: "service_unavailable",
        detail: "The control plane is unavailable.",
        traceId: "tui",
      });
      tui.requestRender();
    },
  );

  await done;
}

class WorkbenchLayout implements Component {
  constructor(
    private readonly navigation: NavigationScreen,
    private readonly chat: ChatScreen,
    private readonly inspector: InspectorScreen,
  ) {}

  render(width: number): string[] {
    if (width < 36) return [
      ...this.navigation.render(width),
      ...this.chat.render(width),
      ...this.inspector.render(width),
    ];
    const navigationWidth = Math.max(14, Math.floor(width * 0.22));
    const inspectorWidth = Math.max(18, Math.floor(width * 0.28));
    const chatWidth = Math.max(1, width - navigationWidth - inspectorWidth - 2);
    const navigation = this.navigation.render(navigationWidth);
    const chat = this.chat.render(chatWidth);
    const inspector = this.inspector.render(inspectorWidth);
    const height = Math.max(navigation.length, chat.length, inspector.length);
    return Array.from({ length: height }, (_, index) => line(
      navigation[index] ?? "",
      navigationWidth,
      chat[index] ?? "",
      chatWidth,
      inspector[index] ?? "",
      inspectorWidth,
      width,
    ));
  }

  invalidate(): void {}
}

function line(
  navigation: string,
  navigationWidth: number,
  chat: string,
  chatWidth: number,
  inspector: string,
  inspectorWidth: number,
  width: number,
): string {
  const columns = [
    pad(navigation, navigationWidth),
    pad(chat, chatWidth),
    pad(inspector, inspectorWidth),
  ];
  return truncateToWidth(columns.join(" "), width);
}

function pad(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
