import {
  ProcessTerminal,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type Terminal,
} from "@mariozechner/pi-tui";

import { PiTuiPrompt } from "./pi-tui-prompt.js";
import { ChatScreen } from "./screens/chat.js";
import { InspectorScreen } from "./screens/inspector.js";
import { NavigationScreen, type WorkbenchDestination } from "./screens/navigation.js";
import { runModelSetupScreen } from "./screens/model-setup.js";
import type { TuiClient } from "./tui-client.js";

type WorkbenchClient = Pick<TuiClient,
  "listAgents" | "listProviderConnections" | "listModelProfiles" | "adminRequest"
>;

export interface RunWorkbenchOptions {
  readonly client: WorkbenchClient;
  readonly terminal?: Terminal;
}

export async function runWorkbench(options: RunWorkbenchOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const inspector = new InspectorScreen();
  const chat = new ChatScreen();
  let closed = false;
  let modelSetupPending = false;
  let resolveExit: (() => void) | undefined;
  const stopped = () => {
    if (closed) return;
    closed = true;
    if (tui.hasOverlay()) tui.hideOverlay();
    resolveExit?.();
  };
  const refresh = (destination: WorkbenchDestination) => {
    void loadDestination(options.client, destination, chat, inspector).finally(() => tui.requestRender());
  };
  const navigation = new NavigationScreen(refresh);
  tui.addChild(new WorkbenchLayout(navigation, chat, inspector));
  tui.setFocus(navigation);
  const finished = new Promise<void>((resolve) => { resolveExit = resolve; });

  try {
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        stopped();
        return { consume: true };
      }
      if (!matchesKey(data, "m") || modelSetupPending) return undefined;
      modelSetupPending = true;
      void runModelSetupScreen({
        prompt: new PiTuiPrompt(tui),
        client: options.client,
        write: () => undefined,
        onProgress: (progress) => {
          chat.show("profiles", [modelSetupLabel(progress)]);
          tui.requestRender();
        },
      }).then(
        () => refresh("profiles"),
        () => inspector.showProblem({
          code: "service_unavailable",
          detail: "Model setup is unavailable.",
          traceId: "tui",
        }),
      ).finally(() => {
        modelSetupPending = false;
        tui.setFocus(navigation);
        tui.requestRender();
      });
      return { consume: true };
    });
    tui.start();
    tui.requestRender(true);
    await finished;
    return 0;
  } finally {
    if (!closed && tui.hasOverlay()) tui.hideOverlay();
    closed = true;
    tui.stop();
  }
}

async function loadDestination(
  client: WorkbenchClient,
  destination: WorkbenchDestination,
  chat: ChatScreen,
  inspector: InspectorScreen,
): Promise<void> {
  chat.show(destination, ["Loading..."]);
  inspector.clear();
  try {
    if (destination === "agents") {
      const response = await client.listAgents();
      chat.show(destination, response.agents.length === 0
        ? ["No Agents are available."]
        : response.agents.map((agent) => `${agent.displayName} (${agent.id})`));
      return;
    }
    if (destination === "providers") {
      const response = await client.listProviderConnections();
      chat.show(destination, response.connections.length === 0
        ? ["No Provider Connections are available."]
        : response.connections.map((connection) => `${connection.displayName} (${connection.connectionId})`));
      return;
    }
    if (destination === "profiles") {
      const response = await client.listModelProfiles();
      chat.show(destination, response.profiles.length === 0
        ? ["No Model Profiles are available. Press m to set up a model."]
        : response.profiles.map((profile) => `${profile.displayName} (${profile.profileId})`));
      return;
    }
    chat.show(destination);
  } catch {
    inspector.showProblem({
      code: "service_unavailable",
      detail: "The control plane is unavailable.",
      traceId: "tui",
    });
  }
}

function modelSetupLabel(progress: string): string {
  return `Model setup: ${progress.replace(/_/gu, " ")}`;
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
      navigation[index] ?? "", navigationWidth, chat[index] ?? "", chatWidth,
      inspector[index] ?? "", inspectorWidth, width,
    ));
  }

  invalidate(): void {}
}

function line(navigation: string, navigationWidth: number, chat: string, chatWidth: number, inspector: string, inspectorWidth: number, width: number): string {
  return truncateToWidth([
    pad(navigation, navigationWidth), pad(chat, chatWidth), pad(inspector, inspectorWidth),
  ].join(" "), width);
}

function pad(value: string, width: number): string {
  const truncated = truncateToWidth(value, width);
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}
