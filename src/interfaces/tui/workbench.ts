import {
  Box,
  ProcessTerminal,
  SelectList,
  Text,
  TUI,
  matchesKey,
  truncateToWidth,
  visibleWidth,
  type Component,
  type OverlayHandle,
  type Terminal,
  type SelectItem,
  type SelectListTheme,
} from "@mariozechner/pi-tui";

import type { ExitImpact } from "../local/exit-impact.js";
import { safeDisplayLines } from "./safe-display-text.js";
import { PiTuiPrompt } from "./pi-tui-prompt.js";
import { ApprovalScreen } from "./screens/approvals.js";
import { AgentScreen } from "./screens/agents.js";
import { ChatScreen } from "./screens/chat.js";
import { RunsScreen } from "./screens/runs.js";
import { SessionsScreen } from "./screens/sessions.js";
import { InspectorScreen } from "./screens/inspector.js";
import { NavigationScreen, type WorkbenchDestination } from "./screens/navigation.js";
import { runModelSetupScreen } from "./screens/model-setup.js";
import { ProviderScreen } from "./screens/providers.js";
import { ProfileScreen } from "./screens/profiles.js";
import { VerificationScreen } from "./screens/verifications.js";
import { AssignmentScreen } from "./screens/assignments.js";
import type { TuiClient } from "./tui-client.js";

type WorkbenchClient = Pick<TuiClient,
  "listAgents" | "listProviderConnections" | "listModelProfiles" | "runModelSetup" |
  "createRun" | "stream" | "listPendingApprovals" | "decideApproval"
> & Partial<Pick<TuiClient,
  "getProviderConnection" | "createProvider" | "reviseProvider" | "discoverProviderModels" |
  "getProviderModels" | "promoteProvider" | "retireProvider" | "listProviderDrivers" | "getModelProfile"
  | "createModelProfile" | "promoteModelProfile" | "retireModelProfile" | "verifyModel"
  | "getModelVerificationAt" | "cancelModelVerification" | "getModelAssignment" | "assignModel"
  | "getDefaultModelProfile" | "setDefaultModelProfile"
  | "createManagedAgent" | "listRunHistory" | "listSessions" | "getRun"
>>;

export interface RunWorkbenchOptions {
  readonly client: WorkbenchClient;
  readonly terminal?: Terminal;
  readonly beforeExit?: () => Promise<ExitImpact>;
}

export async function runWorkbench(options: RunWorkbenchOptions): Promise<number> {
  const terminal = options.terminal ?? new ProcessTerminal();
  const tui = new TUI(terminal);
  const inspector = new InspectorScreen();
  const chat = new ChatScreen({ client: options.client, onChange: () => tui.requestRender() });
  let providerScreen: ProviderScreen | undefined;
  let profileScreen: ProfileScreen | undefined;
  let verificationScreen: VerificationScreen | undefined;
  let assignmentScreen: AssignmentScreen | undefined;
  let agentScreen: AgentScreen | undefined;
  let center: Component = chat;
  let closed = false;
  let modelSetupPending = false;
  let modelSetupReloadRequired = false;
  let modelSetupReloadEpoch = 0;
  let modelSetup: { readonly controller: AbortController; readonly prompt: PiTuiPrompt; readonly done: Promise<void> } | undefined;
  let latestModelSetup: Promise<void> | undefined;
  let chatPrompt: PiTuiPrompt | undefined;
  let latestChatAction: Promise<void> | undefined;
  let approvals: ApprovalScreen | undefined;
  let exitPending = false;
  let exitPrompt: ExitConfirmation | undefined;
  let latestExitAttempt: Promise<void> | undefined;
  let resolveExit: (() => void) | undefined;
  const stopped = () => {
    if (closed) return;
    closed = true;
    modelSetup?.controller.abort();
    modelSetup?.prompt.cancel();
    chat.cancel();
    chatPrompt?.cancel();
    if (tui.hasOverlay()) tui.hideOverlay();
    resolveExit?.();
  };
  const attemptExit = () => {
    if (exitPending || exitPrompt !== undefined) return;
    const beforeExit = options.beforeExit;
    if (beforeExit === undefined) {
      stopped();
      return;
    }
    exitPending = true;
    const attempt = chat.createSettled().then(beforeExit).then((impact) => {
      if (closed) return;
      if (impact.activeRuns.length === 0 && impact.pendingApprovalCount === 0) {
        stopped();
        return;
      }
      exitPending = false;
      const prompt = new ExitConfirmation(impact, (confirmed) => {
        if (exitPrompt !== prompt) return;
        exitPrompt = undefined;
        handle.hide();
        if (confirmed) stopped();
        else tui.requestRender();
      });
      exitPrompt = prompt;
      const handle: OverlayHandle = tui.showOverlay(prompt, { width: "75%", maxHeight: "80%" });
      tui.requestRender();
    }).catch((error: unknown) => {
      if (!closed) {
        inspector.showProblem(safeProblem(
          error,
          "exit_impact_unavailable",
          "Active work could not be inspected. Exit was not performed.",
        ));
      }
    }).finally(() => {
      exitPending = false;
      tui.requestRender();
    });
    latestExitAttempt = attempt;
  };
  const refresh = (destination: WorkbenchDestination) => {
    if (destination === "runs" && isRunHistoryClient(options.client)) {
      const screen = new RunsScreen({ client: options.client, agentId: "primary", sessionKey: "default", onChange: () => tui.requestRender(), onExit: () => { center = chat; tui.setFocus(navigation); tui.requestRender(); } });
      center = screen; tui.setFocus(screen); void screen.load().finally(() => tui.requestRender()); return;
    }
    if (destination === "sessions" && isSessionHistoryClient(options.client)) {
      const screen = new SessionsScreen({ client: options.client, onChange: () => tui.requestRender(), onExit: () => { center = chat; tui.setFocus(navigation); tui.requestRender(); } });
      center = screen; tui.setFocus(screen); void screen.load().finally(() => tui.requestRender()); return;
    }
    if (destination === "providers" && isProviderClient(options.client)) {
      const screen = new ProviderScreen({
        client: options.client,
        inspector,
        promptFactory: () => new PiTuiPrompt(tui),
        onChange: () => tui.requestRender(),
        onExit: () => {
          center = chat;
          tui.setFocus(navigation);
          tui.requestRender();
        },
      });
      providerScreen = screen;
      center = screen;
      tui.setFocus(screen);
      void screen.load().finally(() => tui.requestRender());
      return;
    }
    if (destination === "profiles" && isProfileClient(options.client)) {
      const screen = new ProfileScreen({ client: options.client, inspector, promptFactory: () => new PiTuiPrompt(tui), onChange: () => tui.requestRender(), onExit: () => { center = chat; tui.setFocus(navigation); tui.requestRender(); } });
      profileScreen = screen; center = screen; tui.setFocus(screen); void screen.load().finally(() => tui.requestRender()); return;
    }
    if (destination === "verifications" && isVerificationClient(options.client)) {
      const screen = new VerificationScreen({ client: options.client, inspector, promptFactory: () => new PiTuiPrompt(tui), onChange: () => tui.requestRender(), onExit: () => { center = chat; tui.setFocus(navigation); tui.requestRender(); } });
      verificationScreen = screen; center = screen; tui.setFocus(screen); tui.requestRender(); return;
    }
    if (destination === "agents" && !isAgentClient(options.client) && isAssignmentClient(options.client)) {
      const screen = new AssignmentScreen({ client: options.client, inspector, promptFactory: () => new PiTuiPrompt(tui), onChange: () => tui.requestRender(), onExit: () => { center = chat; tui.setFocus(navigation); tui.requestRender(); } });
      assignmentScreen = screen; center = screen; tui.setFocus(screen); void screen.load().finally(() => tui.requestRender()); return;
    }
    if (destination === "agents" && isAgentClient(options.client)) {
      const screen = new AgentScreen({ client: options.client, inspector, promptFactory: () => new PiTuiPrompt(tui), onAssignments: () => { if (!isAssignmentClient(options.client)) return; const assignments = new AssignmentScreen({ client: options.client, inspector, promptFactory: () => new PiTuiPrompt(tui), onChange: () => tui.requestRender(), onExit: () => { center = screen; tui.setFocus(screen); tui.requestRender(); } }); assignmentScreen = assignments; center = assignments; tui.setFocus(assignments); void assignments.load().finally(() => tui.requestRender()); }, onChange: () => tui.requestRender(), onExit: () => { center = chat; tui.setFocus(navigation); tui.requestRender(); } });
      agentScreen = screen; center = screen; tui.setFocus(screen); void screen.load().finally(() => tui.requestRender()); return;
    }
    center = chat;
    tui.setFocus(navigation);
    const startedAtReloadEpoch = modelSetupReloadEpoch;
    void loadDestination(options.client, destination, chat, inspector).then((loaded) => {
      if (
        loaded &&
        startedAtReloadEpoch === modelSetupReloadEpoch &&
        destination === "profiles"
      ) {
        modelSetupReloadRequired = false;
      }
    }).finally(() => tui.requestRender());
  };
  const navigation = new NavigationScreen(refresh);
  tui.addChild(new WorkbenchLayout(navigation, () => center, inspector));
  tui.setFocus(navigation);
  const finished = new Promise<void>((resolve) => { resolveExit = resolve; });

  try {
    tui.addInputListener((data) => {
      if (matchesKey(data, "ctrl+c")) {
        attemptExit();
        return { consume: true };
      }
      if (exitPrompt !== undefined) return undefined;
      if (exitPending) return { consume: true };
      if (matchesKey(data, "c") && center === chat && chatPrompt === undefined && !modelSetupPending && !tui.hasOverlay()) {
        const prompt = new PiTuiPrompt(tui);
        chatPrompt = prompt;
        const action = submitChat(prompt, chat, () => !exitPending).catch((error: unknown) => {
          if (!closed) inspector.showProblem(safeProblem(error, "run_create_failed", "The Run could not be created."));
        }).finally(() => {
          if (chatPrompt === prompt) chatPrompt = undefined;
          tui.setFocus(navigation);
          tui.requestRender();
        });
        latestChatAction = action;
        return { consume: true };
      }
      if (matchesKey(data, "r") && !tui.hasOverlay()) {
        if (center !== chat) return undefined;
        if (chat.busy) return { consume: true };
        const action = chat.reconnect().then(() => undefined).catch((error: unknown) => {
          inspector.showProblem(safeProblem(error, "run_stream_failed", "The committed Run stream is unavailable."));
        }).finally(() => tui.requestRender());
        latestChatAction = action;
        return { consume: true };
      }
      if (matchesKey(data, "a") && center === chat && !modelSetupPending && !tui.hasOverlay()) {
        const screen = new ApprovalScreen({
          client: options.client,
          onChange: () => tui.requestRender(),
          onExit: () => {
            if (approvals !== screen) return;
            approvals = undefined;
            if (tui.hasOverlay()) tui.hideOverlay();
            tui.setFocus(navigation);
            tui.requestRender();
          },
        });
        approvals = screen;
        tui.showOverlay(screen, { width: "75%", maxHeight: "80%" });
        tui.setFocus(screen);
        void screen.load();
        return { consume: true };
      }
      if (!matchesKey(data, "m") || center !== chat || modelSetupPending || tui.hasOverlay()) return undefined;
      if (modelSetupReloadRequired) {
        inspector.showConflict();
        tui.requestRender();
        return { consume: true };
      }
      modelSetupPending = true;
      const controller = new AbortController();
      const prompt = new PiTuiPrompt(tui);
      const done = runModelSetupScreen({
        prompt,
        client: options.client,
        signal: controller.signal,
        write: () => undefined,
        onProgress: (progress) => {
          chat.show("profiles", [modelSetupLabel(progress)]);
          tui.requestRender();
        },
      }).then((outcome) => {
        if (outcome.status === "conflict") {
          prompt.cancel();
          modelSetupReloadEpoch += 1;
          modelSetupReloadRequired = true;
          chat.show("profiles", ["Model setup stopped. Reload required."]);
          inspector.showConflict();
          return;
        }
        refresh("profiles");
      }, () => {
        inspector.showProblem({
          code: "service_unavailable",
          detail: "Model setup is unavailable.",
          traceId: "tui",
        });
      }).finally(() => {
        modelSetupPending = false;
        modelSetup = undefined;
        tui.setFocus(navigation);
        tui.requestRender();
      });
      modelSetup = { controller, prompt, done };
      latestModelSetup = done;
      return { consume: true };
    });
    tui.start();
    tui.requestRender(true);
    await finished;
    await latestModelSetup;
    await latestChatAction;
    await latestExitAttempt;
    await approvals?.settled();
    await providerScreen?.settled();
    await profileScreen?.settled();
    await verificationScreen?.settled();
    await assignmentScreen?.settled();
    await agentScreen?.settled();
    return 0;
  } finally {
    if (!closed && tui.hasOverlay()) tui.hideOverlay();
    closed = true;
    tui.stop();
  }
}

function isProfileClient(client: WorkbenchClient): client is WorkbenchClient & ConstructorParameters<typeof ProfileScreen>[0]["client"] {
  return typeof client.getModelProfile === "function" && typeof client.createModelProfile === "function" && typeof client.promoteModelProfile === "function" && typeof client.retireModelProfile === "function";
}

function isVerificationClient(client: WorkbenchClient): client is WorkbenchClient & ConstructorParameters<typeof VerificationScreen>[0]["client"] {
  return typeof client.verifyModel === "function" && typeof client.getModelVerificationAt === "function" && typeof client.cancelModelVerification === "function";
}

function isAssignmentClient(client: WorkbenchClient): client is WorkbenchClient & ConstructorParameters<typeof AssignmentScreen>[0]["client"] {
  return typeof client.getModelProfile === "function" && typeof client.getModelAssignment === "function" && typeof client.assignModel === "function" && typeof client.getDefaultModelProfile === "function" && typeof client.setDefaultModelProfile === "function";
}

function isRunHistoryClient(client: WorkbenchClient): client is WorkbenchClient & ConstructorParameters<typeof RunsScreen>[0]["client"] {
  return typeof client.listRunHistory === "function";
}

function isSessionHistoryClient(client: WorkbenchClient): client is WorkbenchClient & ConstructorParameters<typeof SessionsScreen>[0]["client"] {
  return typeof client.listSessions === "function";
}

function isAgentClient(client: WorkbenchClient): client is WorkbenchClient & Required<Pick<TuiClient, "createManagedAgent">> {
  return typeof client.createManagedAgent === "function";
}

function isProviderClient(client: WorkbenchClient): client is WorkbenchClient & ConstructorParameters<typeof ProviderScreen>[0]["client"] {
  return typeof client.getProviderConnection === "function" &&
    typeof client.createProvider === "function" &&
    typeof client.reviseProvider === "function" &&
    typeof client.discoverProviderModels === "function" &&
    typeof client.getProviderModels === "function" &&
    typeof client.promoteProvider === "function" &&
    typeof client.retireProvider === "function" &&
    typeof client.listProviderDrivers === "function" &&
    typeof client.getModelProfile === "function";
}

const exitSelectTheme: SelectListTheme = {
  selectedPrefix: (value) => `> ${value}`,
  selectedText: (value) => value,
  description: (value) => value,
  scrollInfo: (value) => value,
  noMatch: (value) => value,
};

class ExitConfirmation implements Component {
  focused = false;
  private readonly box = new Box(1, 1);
  private readonly choices: SelectList;

  constructor(impact: ExitImpact, complete: (confirmed: boolean) => void) {
    this.box.addChild(new Text("Exit MyAgent?"));
    const summary = [
      ...impact.activeRuns.map((run) => `Run ${run.runId} (${run.status})`),
      ...(impact.pendingApprovalCount === 0
        ? []
        : [`${String(impact.pendingApprovalCount)} pending Approvals`]),
    ].flatMap(safeDisplayLines);
    this.box.addChild(new Text(summary.join("\n")));
    const items: SelectItem[] = [
      { value: "yes", label: "Yes, exit" },
      { value: "no", label: "No, resume" },
    ];
    this.choices = new SelectList(items, items.length, exitSelectTheme);
    this.choices.onSelect = (item) => complete(item.value === "yes");
    this.choices.onCancel = () => complete(false);
    this.box.addChild(this.choices);
  }

  handleInput(data: string): void { this.choices.handleInput(data); }
  render(width: number): string[] { return this.box.render(width); }
  invalidate(): void { this.box.invalidate(); }
}

async function submitChat(
  prompt: PiTuiPrompt,
  chat: ChatScreen,
  canSubmit: () => boolean,
): Promise<void> {
  const agentId = await prompt.input("Agent ID");
  const sessionKey = await prompt.input("Session Key");
  const text = await prompt.input("Message");
  if (!canSubmit()) return;
  await chat.submit({ agentId, sessionKey, text });
}

function safeProblem(
  error: unknown,
  fallbackCode: string,
  fallbackDetail: string,
): { readonly code: string; readonly detail: string; readonly traceId: string } {
  if (typeof error !== "object" || error === null) {
    return { code: fallbackCode, detail: fallbackDetail, traceId: "tui" };
  }
  const candidate = error as { code?: unknown; detail?: unknown; traceId?: unknown };
  return {
    code: typeof candidate.code === "string" ? candidate.code : fallbackCode,
    detail: typeof candidate.detail === "string" ? candidate.detail : fallbackDetail,
    traceId: typeof candidate.traceId === "string" ? candidate.traceId : "tui",
  };
}

async function loadDestination(
  client: WorkbenchClient,
  destination: WorkbenchDestination,
  chat: ChatScreen,
  inspector: InspectorScreen,
): Promise<boolean> {
  chat.show(destination, ["Loading..."]);
  inspector.clear();
  try {
    if (destination === "agents") {
      const response = await client.listAgents();
      chat.show(destination, response.agents.length === 0
        ? ["No Agents are available."]
        : response.agents.map((agent) => `${agent.displayName} (${agent.id})`));
      return true;
    }
    if (destination === "providers") {
      const response = await client.listProviderConnections();
      chat.show(destination, response.connections.length === 0
        ? ["No Provider Connections are available."]
        : response.connections.map((connection) => `${connection.displayName} (${connection.connectionId})`));
      return true;
    }
    if (destination === "profiles") {
      const response = await client.listModelProfiles();
      chat.show(destination, response.profiles.length === 0
        ? ["No Model Profiles are available. Press m to set up a model."]
        : response.profiles.map((profile) => `${profile.displayName} (${profile.profileId})`));
      return true;
    }
    chat.show(destination);
    return true;
  } catch {
    inspector.showProblem({
      code: "service_unavailable",
      detail: "The control plane is unavailable.",
      traceId: "tui",
    });
    return false;
  }
}

function modelSetupLabel(progress: string): string {
  return `Model setup: ${progress.replace(/_/gu, " ")}`;
}

class WorkbenchLayout implements Component {
  constructor(
    private readonly navigation: NavigationScreen,
    private readonly center: () => Component,
    private readonly inspector: InspectorScreen,
  ) {}

  render(width: number): string[] {
    if (width < 36) return [
      ...this.navigation.render(width),
      ...this.center().render(width),
      ...this.inspector.render(width),
    ];
    const navigationWidth = Math.max(14, Math.floor(width * 0.22));
    const inspectorWidth = Math.max(18, Math.floor(width * 0.28));
    const chatWidth = Math.max(1, width - navigationWidth - inspectorWidth - 2);
    const navigation = this.navigation.render(navigationWidth);
    const chat = this.center().render(chatWidth);
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
