import type { Terminal } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";
import { describe, expect, it, vi } from "vitest";

import {
  CliPromptCancelledError,
  setupModel,
  type CliPrompt,
  type SetupModelProgressCallback,
} from "../../src/interfaces/cli/commands/model-setup.js";
import type { AdminClient } from "../../src/interfaces/cli/commands/providers.js";
import { CliHttpError } from "../../src/interfaces/cli/client.js";
import { runWorkbench } from "../../src/interfaces/tui/workbench.js";
import { ApprovalScreen } from "../../src/interfaces/tui/screens/approvals.js";
import { InspectorScreen } from "../../src/interfaces/tui/screens/inspector.js";
import { runModelSetupScreen } from "../../src/interfaces/tui/screens/model-setup.js";
import { TuiClient } from "../../src/interfaces/tui/tui-client.js";
import type { ModelProfileResponse } from "../../src/interfaces/http/model-control-schemas.js";

describe("TUI workbench", () => {
  it("exits immediately without a prompt when no durable work is active", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const beforeExit = vi.fn(async () => ({ activeRuns: [], pendingApprovalCount: 0 }));
    const workbench = runWorkbench({ client: safeClient(), terminal, beforeExit });

    await terminal.ready();
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(beforeExit).toHaveBeenCalledOnce();
    expect(plainLines(terminal.frames.join("\n")).join("\n")).not.toContain("Exit MyAgent?");
  });

  it("shows active Run IDs and pending Approval count, then resumes after exit is declined", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const beforeExit = vi.fn(async () => ({
      activeRuns: [
        { runId: "run_queued", status: "queued" as const },
        { runId: "run_cancelling", status: "cancelling" as const },
      ],
      pendingApprovalCount: 3,
    }));
    const workbench = runWorkbench({ client: safeClient(), terminal, beforeExit });

    await terminal.ready();
    terminal.input("\u0003");
    await terminal.waitForFrame("run_cancelling");
    expect(plainLines(terminal.frames.at(-1) ?? "").join("\n")).toContain("3 pending Approvals");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Navigation");
    expect(terminal.stopCalls).toBe(0);

    terminal.input("\u0003");
    await vi.waitFor(() => { expect(beforeExit).toHaveBeenCalledTimes(2); });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    terminal.input("\r");

    await expect(workbench).resolves.toBe(0);
    expect(beforeExit).toHaveBeenCalledTimes(2);
    expect(terminal.stopCalls).toBe(1);
  });

  it("takes the exit snapshot after an in-flight Run creation settles and blocks new mutations", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const events: string[] = [];
    let resolveCreate: ((value: {
      readonly runId: string;
      readonly status: "queued";
      readonly eventsUrl: string;
    }) => void) | undefined;
    const createRun = vi.fn(() => {
      events.push("create_started");
      return new Promise<{
        readonly runId: string;
        readonly status: "queued";
        readonly eventsUrl: string;
      }>((resolve) => { resolveCreate = resolve; });
    });
    let committed = false;
    let resolveInspection: (() => void) | undefined;
    const inspectionRelease = new Promise<void>((resolve) => { resolveInspection = resolve; });
    const beforeExit = vi.fn(() => {
      events.push("inspection_started");
      const snapshot = committed
        ? { activeRuns: [{ runId: "run_committed", status: "queued" as const }], pendingApprovalCount: 0 }
        : { activeRuns: [], pendingApprovalCount: 0 };
      return inspectionRelease.then(() => snapshot);
    });
    const listPendingApprovals = vi.fn(async () => ({ approvals: [] }));
    let adminRequestCount = 0;
    const adminRequest = async <T>(
      path: string,
      init?: { readonly method?: string },
    ): Promise<T> => {
      adminRequestCount += 1;
      void path;
      void init;
      return {} as T;
    };
    const client = safeClient({
      createRun,
      stream: async () => sseResponse([
        eventFrame(1, "run.completed", { result: { type: "text", text: "done" } }),
      ]),
      listPendingApprovals,
      adminRequest,
    });
    const workbench = runWorkbench({ client, terminal, beforeExit });

    await terminal.ready();
    terminal.input("c");
    await terminal.waitForFrame("Agent ID");
    terminal.input("primary");
    terminal.input("\r");
    await terminal.waitForFrame("Session Key");
    terminal.input("tui:barrier");
    terminal.input("\r");
    await terminal.waitForFrame("Message");
    terminal.input("commit first");
    terminal.input("\r");
    await vi.waitFor(() => { expect(createRun).toHaveBeenCalledOnce(); });
    terminal.input("\u0003");

    committed = true;
    events.push("create_committed");
    resolveCreate?.({
      runId: "run_committed",
      status: "queued",
      eventsUrl: "/v1/runs/run_committed/events",
    });
    await vi.waitFor(() => { expect(beforeExit).toHaveBeenCalledOnce(); });
    terminal.input("c");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    terminal.input("\u001b");
    terminal.input("a");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    terminal.input("\u001b");
    terminal.input("m");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    resolveInspection?.();
    const outcome = await Promise.race([
      workbench.then(() => "resolved" as const),
      terminal.waitForFrame("Exit MyAgent?").then(() => "prompt" as const),
    ]);
    if (outcome === "prompt") {
      terminal.input("\r");
      await workbench;
    }

    expect(outcome).toBe("prompt");
    expect(events.slice(0, 3)).toEqual([
      "create_started",
      "create_committed",
      "inspection_started",
    ]);
    expect(createRun).toHaveBeenCalledOnce();
    expect(listPendingApprovals).not.toHaveBeenCalled();
    expect(adminRequestCount).toBe(0);
  });

  it("restores the exact active prompt and focus after exit is declined", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    let inspections = 0;
    const beforeExit = vi.fn(async () => {
      inspections += 1;
      return inspections === 1
        ? { activeRuns: [{ runId: "run_1", status: "running" as const }], pendingApprovalCount: 0 }
        : { activeRuns: [], pendingApprovalCount: 0 };
    });
    const workbench = runWorkbench({ client: safeClient(), terminal, beforeExit });

    await terminal.ready();
    terminal.input("c");
    await terminal.waitForFrame("Agent ID");
    terminal.input("\u0003");
    await terminal.waitForFrame("Exit MyAgent?");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    terminal.input("primary");
    terminal.input("\r");
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
    const restoredPrompt = terminal.frames.at(-1)?.includes("Session Key") === true;
    terminal.input("\u0003");

    await workbench;
    expect(restoredPrompt).toBe(true);
  });

  it("aborts and awaits a stalled Run creation without letting reconnect displace it", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    let createSignal: AbortSignal | undefined;
    let rejectCreate: ((error: Error) => void) | undefined;
    let observedAbort: (() => void) | undefined;
    const abortObserved = new Promise<void>((resolve) => { observedAbort = resolve; });
    const createRun = vi.fn((input: { readonly signal?: AbortSignal }) => {
      createSignal = input.signal;
      input.signal?.addEventListener("abort", () => observedAbort?.(), { once: true });
      return new Promise<{
        readonly runId: string;
        readonly status: "queued";
        readonly eventsUrl: string;
      }>((_resolve, reject) => { rejectCreate = reject; });
    });
    const stream = vi.fn(async () => sseResponse([]));
    const workbench = runWorkbench({ client: safeClient({ createRun, stream }), terminal });

    await terminal.ready();
    terminal.input("c");
    await terminal.waitForFrame("Agent ID");
    terminal.input("primary");
    terminal.input("\r");
    await terminal.waitForFrame("Session Key");
    terminal.input("tui:stalled");
    terminal.input("\r");
    await terminal.waitForFrame("Message");
    terminal.input("wait");
    terminal.input("\r");
    await vi.waitFor(() => { expect(createRun).toHaveBeenCalledOnce(); });
    terminal.input("r");
    terminal.input("\u0003");
    await abortObserved;

    await expect(Promise.race([
      workbench.then(() => "resolved"),
      new Promise<string>((resolve) => setTimeout(() => resolve("pending"), 20)),
    ])).resolves.toBe("pending");
    expect(createSignal?.aborted).toBe(true);
    expect(stream).not.toHaveBeenCalled();
    rejectCreate?.(new DOMException("aborted", "AbortError"));

    await expect(workbench).resolves.toBe(0);
    expect(terminal.stopCalls).toBe(1);
  });

  it("creates one explicitly-bound Run and reconnects its committed event cursor", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const createRun = vi.fn(async () => ({
      runId: "run_1",
      status: "queued" as const,
      eventsUrl: "/v1/runs/run_1/events",
    }));
    const cursors: (string | undefined)[] = [];
    let attempt = 0;
    const client = safeClient({
      createRun,
      stream: async (_path, lastEventId) => {
        cursors.push(lastEventId);
        attempt += 1;
        return attempt === 1
          ? interruptedSseResponse(eventFrame(4, "message.delta", { text: "safe status" }))
          : sseResponse([eventFrame(5, "run.completed", { result: { type: "text", text: "done" } })]);
      },
    });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("c");
    await terminal.waitForFrame("Agent ID");
    terminal.input("primary");
    terminal.input("\r");
    await terminal.waitForFrame("Session Key");
    terminal.input("tui:main");
    terminal.input("\r");
    await terminal.waitForFrame("Message");
    terminal.input("read status");
    terminal.input("\r");
    await terminal.waitForFrame("Reconnect available");
    terminal.input("r");
    await terminal.waitForFrame("run.completed");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(createRun).toHaveBeenCalledOnce();
    expect(createRun).toHaveBeenCalledWith(expect.objectContaining({
      agentId: "primary",
      sessionKey: "tui:main",
      text: "read status",
    }));
    expect(cursors).toEqual([undefined, "4"]);
  });

  it("opens pending Approvals and dispatches one selected decision", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const decideApproval = vi.fn(async () => ({
      approvalId: "apr_1",
      runId: "run_1",
      state: "approved" as const,
      resolvedAt: "2026-08-12T00:00:00.000Z",
    }));
    const workbench = runWorkbench({
      terminal,
      client: safeClient({
        approvals: [pendingApproval()],
        decideApproval,
      }),
    });

    await terminal.ready();
    terminal.input("a");
    await terminal.waitForFrame("write_file");
    terminal.input("y");
    await terminal.waitForFrame("Server state: approved");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(decideApproval).toHaveBeenCalledExactlyOnceWith("apr_1", "approve");
  });

  it("approves one exact pending Tool Call with Run authority and renders the server state", async () => {
    const decisionBodies: unknown[] = [];
    const decisionAuthorizations: (string | null)[] = [];
    let lists = 0;
    const client = new TuiClient({
      runToken: "run-token",
      adminToken: "admin-token",
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        if (url.pathname === "/v1/approvals") {
          lists += 1;
          return Response.json({ approvals: lists === 1 ? [{
            approvalId: "apr_1",
            runId: "run_1",
            toolCallId: "tool_1",
            state: "pending",
            toolName: "run_command",
            arguments: {
              content: "provider-secret",
              nested: { credential: "nested-secret" },
              items: [{ value: "array-secret" }],
            },
            expiresAt: "2026-08-13T00:00:00.000Z",
            riskNotice: "This command runs on the host and is not isolated by an OS sandbox.",
          }] : [] });
        }
        decisionBodies.push(JSON.parse(String(init?.body)) as unknown);
        decisionAuthorizations.push(new Headers(init?.headers).get("authorization"));
        return Response.json({
          approvalId: "apr_1",
          runId: "run_1",
          state: "denied",
          resolvedAt: "2026-08-12T00:00:00.000Z",
        });
      },
    });
    const approvals = new ApprovalScreen({ client });

    await approvals.load();
    await approvals.select("apr_1");
    const retained = JSON.stringify((approvals as unknown as { approvals: unknown }).approvals);
    const beforeDecision = approvals.render(120).join("\n");
    expect(beforeDecision).toContain("This command runs on the host");
    expect(beforeDecision).toContain("content: string");
    expect(beforeDecision).toContain("nested.credential: string");
    expect(beforeDecision).toContain("items[]: object");
    expect(`${retained}\n${beforeDecision}`).not.toContain("provider-secret");
    expect(`${retained}\n${beforeDecision}`).not.toContain("nested-secret");
    expect(`${retained}\n${beforeDecision}`).not.toContain("array-secret");
    await approvals.decide("approved");
    await expect(approvals.decide("denied")).resolves.toBe(false);

    expect(decisionBodies).toEqual([{ decision: "approve" }]);
    expect(decisionAuthorizations).toEqual(["Bearer run-token"]);
    expect(approvals.render(120).join("\n")).toContain("denied");
    expect(approvals.render(120).join("\n")).not.toContain("approved");
    expect(approvals.controlsEnabled).toBe(false);
  });

  it("disables Approval controls while one exact decision is in flight", async () => {
    let resolveDecision: ((value: {
      approvalId: string;
      runId: string;
      state: "approved";
      resolvedAt: string;
    }) => void) | undefined;
    const decision = new Promise<{
      approvalId: string;
      runId: string;
      state: "approved";
      resolvedAt: string;
    }>((resolve) => { resolveDecision = resolve; });
    const decideApproval = vi.fn(() => decision);
    const approvals = new ApprovalScreen({
      client: {
        listPendingApprovals: async () => ({ approvals: [pendingApproval()] }),
        decideApproval,
      },
    });
    await approvals.load();
    await approvals.select("apr_1");

    const first = approvals.decide("approved");
    const second = approvals.decide("denied");
    expect(approvals.controlsEnabled).toBe(false);
    await expect(second).resolves.toBe(false);
    expect(decideApproval).toHaveBeenCalledTimes(1);
    resolveDecision?.({
      approvalId: "apr_1",
      runId: "run_1",
      state: "approved",
      resolvedAt: "2026-08-12T00:00:00.000Z",
    });
    await expect(first).resolves.toBe(true);
  });

  it("locks the server outcome instead of activating the next pending Approval", async () => {
    const decideApproval = vi.fn(async (approvalId: string) => ({
      approvalId,
      runId: "run_1",
      state: "approved" as const,
      resolvedAt: "2026-08-12T00:00:00.000Z",
    }));
    const approvals = new ApprovalScreen({
      client: {
        listPendingApprovals: async () => ({ approvals: [
          pendingApproval(),
          { ...pendingApproval(), approvalId: "apr_2", toolCallId: "tool_2" },
        ] }),
        decideApproval,
      },
    });
    await approvals.load();
    await approvals.select("apr_1");

    await expect(approvals.decide("approved")).resolves.toBe(true);
    await expect(approvals.select("apr_2")).resolves.toBe(false);
    await expect(approvals.decide("denied")).resolves.toBe(false);

    expect(decideApproval).toHaveBeenCalledExactlyOnceWith("apr_1", "approve");
    expect(approvals.controlsEnabled).toBe(false);
    const rendered = approvals.render(120).join("\n");
    expect(rendered).toContain("Server state: approved");
    expect(rendered).toContain("Approval apr_1");
  });

  it("retires an externally resolved Approval after the first local decision fails", async () => {
    const decideApproval = vi.fn(async () => {
      throw Object.assign(new Error("approval_already_resolved"), {
        code: "approval_already_resolved",
        detail: "This Approval was already resolved.",
        traceId: "trace_1",
      });
    });
    const approvals = new ApprovalScreen({
      client: {
        listPendingApprovals: async () => ({ approvals: [
          pendingApproval(),
          { ...pendingApproval(), approvalId: "apr_2", toolCallId: "tool_2" },
        ] }),
        decideApproval,
      },
    });
    await approvals.load();
    await approvals.select("apr_1");

    await expect(approvals.decide("denied")).resolves.toBe(false);
    await expect(approvals.select("apr_2")).resolves.toBe(false);
    await expect(approvals.decide("approved")).resolves.toBe(false);

    const rendered = approvals.render(120).join("\n");
    expect(rendered).toContain("approval_already_resolved");
    expect(rendered).not.toContain("Server state: approved");
    expect(rendered).not.toContain("denied");
    expect(approvals.controlsEnabled).toBe(false);
    expect(decideApproval).toHaveBeenCalledOnce();
  });

  it("keeps an in-flight Approval open until its server response settles", async () => {
    let exits = 0;
    let resolveDecision: ((value: {
      approvalId: string;
      runId: string;
      state: "approved";
      resolvedAt: string;
    }) => void) | undefined;
    const decision = new Promise<{
      approvalId: string;
      runId: string;
      state: "approved";
      resolvedAt: string;
    }>((resolve) => { resolveDecision = resolve; });
    const approvals = new ApprovalScreen({
      client: {
        listPendingApprovals: async () => ({ approvals: [pendingApproval()] }),
        decideApproval: async () => decision,
      },
      onExit: () => { exits += 1; },
    });
    await approvals.load();
    await approvals.select("apr_1");

    const deciding = approvals.decide("approved");
    approvals.handleInput("\u001b");
    expect(exits).toBe(0);
    resolveDecision?.({
      approvalId: "apr_1",
      runId: "run_1",
      state: "approved",
      resolvedAt: "2026-08-12T00:00:00.000Z",
    });
    await deciding;
    approvals.handleInput("\u001b");
    expect(exits).toBe(1);
  });

  it("renders three bounded regions and restores the terminal on exit", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36, inputs: ["\u0003"] });

    await expect(runWorkbench({ client: safeClient(), terminal })).resolves.toBe(0);

    expect(terminal.frames.at(-1)).toContain("Runs");
    expect(terminal.frames.at(-1)).toContain("Inspect");
    expect(terminal.stopCalls).toBe(1);
  });

  it("routes navigation input into the main pane and loads safe Agent summaries", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client: safeClient(), terminal });

    await terminal.ready();
    terminal.input("\u001b[A");
    terminal.input("\r");
    await terminal.waitForFrame("Research Agent");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(terminal.frames.at(-1)).toContain("Agents");
    expect(terminal.frames.at(-1)).toContain("Research Agent");
  });

  it("loads safe Provider Connection and Model Profile summaries through navigation", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client: safeClient(), terminal });

    await terminal.ready();
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Provider One");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Model One");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    expect(terminal.frames.at(-1)).toContain("Profiles");
    expect(terminal.frames.at(-1)).toContain("Model One");
  });

  it("routes Profiles, Assignments, and Verification q/x controls through the workbench", async () => {
    const cancelModelVerification = vi.fn(async () => verificationView("cancelled", 4));
    const client = {
      ...safeClient(),
      getModelProfile: async () => modelProfileView(),
      createModelProfile: async () => modelProfileView(),
      promoteModelProfile: async () => modelProfileView(),
      retireModelProfile: async () => modelProfileView(),
      getProviderConnection: async () => providerConnectionView(),
      verifyModel: async () => ({
        verificationId: "ver_one", profileRevisionId: "mpr_verified",
        capabilityBaseline: "text_and_single_tool_call_v1" as const,
        status: "queued" as const, recordRevision: 1,
        operationUrl: "/v1/admin/operations/opaque-verification-status",
      }),
      getModelVerification: async () => verificationView("running", 3),
      getModelVerificationAt: async () => verificationView("running", 3),
      cancelModelVerification,
      getModelAssignment: async () => ({ agentId: "research", state: "unassigned" as const, modelProfileRevisionId: null, source: null, recordRevision: null, updatedAt: null }),
      assignModel: async () => ({ agentId: "research", state: "assigned" as const, modelProfileRevisionId: "mpr_verified", source: "explicit" as const, recordRevision: 1, updatedAt: "2026-08-13T00:00:00.000Z" }),
      getDefaultModelProfile: async () => ({ state: "unset" as const, profileId: null, recordRevision: null }),
      setDefaultModelProfile: async () => ({ state: "configured" as const, profileId: "model-one", recordRevision: 1 }),
    };
    await navigateWorkbench(client, ["\u001b[B", "\u001b[B"], "Profiles");
    await navigateWorkbench(client, ["\u001b[A"], "Assignments");

    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client, terminal });
    await terminal.ready();
    for (const key of ["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B"]) terminal.input(key);
    terminal.input("\r");
    await terminal.waitForFrame("Verifications");
    terminal.input("q");
    await terminal.waitForFrame("Profile revision ID");
    terminal.input("mpr_verified"); terminal.input("\r");
    await terminal.waitForFrame("Profile record revision");
    terminal.input("2"); terminal.input("\r");
    await terminal.waitForFrame("ver_one (running)");
    terminal.input("x");
    await terminal.waitForFrame("Cancel this Verification?"); terminal.input("\r");
    await vi.waitFor(() => expect(cancelModelVerification).toHaveBeenCalledWith("ver_one", { expectedRevision: 3 }));
    await terminal.waitForFrame("ver_one (cancelled)");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
  });

  it("does not instantiate Verifications when the client lacks opaque operation polling", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const verifyModel = vi.fn();
    const client = {
      ...safeClient(),
      verifyModel,
      getModelVerification: vi.fn(),
      cancelModelVerification: vi.fn(),
    };
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    for (const key of ["\u001b[B", "\u001b[B", "\u001b[B", "\u001b[B"]) terminal.input(key);
    terminal.input("\r");
    await terminal.waitForFrame("Verifications");
    terminal.input("q");
    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    expect(verifyModel).not.toHaveBeenCalled();
    expect(plainLines(terminal.frames.at(-1) ?? "").join("\n")).not.toContain("Profile revision ID");
    terminal.input("\u0003");
    await expect(workbench).resolves.toBe(0);
  });

  it("does not render control sequences or credential lines from typed list summaries", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const client = safeClient({
      agents: [{ id: "research", displayName: "Research\u001b[31m Agent\nAuthorization: Bearer hidden-agent", revisionId: "rev_1" }],
      connections: [{ connectionId: "provider-one", displayName: "Provider One\nAPI key: hidden-provider", activeRevisionId: "pcr_1", retiredAt: null }],
      profiles: [{ profileId: "model-one", displayName: "Model One\nBearer\ntoken=hidden-model", activeRevisionId: "mpr_1", retiredAt: null }],
    });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("\u001b[A");
    terminal.input("\r");
    await terminal.waitForFrame("Research Agent");
    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Provider One");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Model One");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    const output = plainLines(terminal.frames.join("\n")).join("\n");
    expect(output).toContain("Research Agent");
    expect(output).toContain("Provider One");
    expect(output).toContain("Model One");
    expect(output).not.toContain("Authorization");
    expect(output).not.toContain("hidden-agent");
    expect(output).not.toContain("API key");
    expect(output).not.toContain("hidden-provider");
    expect(output).not.toContain("Bearer");
    expect(output).not.toContain("token=hidden-model");
  });

  it("opens the existing masked model-setup workflow with m", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const workbench = runWorkbench({ client: safeClient(), terminal });

    await terminal.ready();
    terminal.input("m");
    await terminal.waitForFrame("Provider");
    terminal.input("\u001b");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
  });

  it("requires a successful registry reload after setup Promotion conflicts", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const requests: string[] = [];
    const client = safeClient({
      adminRequest: async (path: string) => {
        requests.push(path);
        throw new CliHttpError(409, "revision_conflict", "provider-secret stale response", "trace-secret");
      },
    });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("m");
    await terminal.waitForFrame("Reload required");

    const requestCountAtConflict = requests.length;
    const conflictFrame = plainLines(terminal.frames.at(-1) ?? "").join("\n");
    expect(conflictFrame).toContain("Model setup stopped");
    expect(conflictFrame).not.toContain("promoting model");
    terminal.input("m");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(requests).toHaveLength(requestCountAtConflict);
    expect(plainLines(terminal.frames.join("\n")).join("\n")).not.toContain("provider-secret");

    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await terminal.waitForFrame("Model One");
    terminal.input("m");
    await vi.waitFor(() => { expect(requests).toHaveLength(requestCountAtConflict + 1); });
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
  });

  it("does not let a pre-conflict Profile reload clear the reload requirement", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    let resolvePreConflictReload: (() => void) | undefined;
    const preConflictReload = new Promise<void>((resolve) => { resolvePreConflictReload = resolve; });
    let profileLoads = 0;
    const setupRequests: string[] = [];
    const client = {
      ...safeClient(),
      listModelProfiles: async () => {
        profileLoads += 1;
        if (profileLoads === 1) await preConflictReload;
        return { profiles: [{
          profileId: "model-one",
          displayName: profileLoads === 1 ? "Model One" : "Fresh Model",
          activeRevisionId: "mpr_1",
          retiredAt: null,
        }] };
      },
      runModelSetup: modelSetupCapability(async (path: string) => {
          setupRequests.push(path);
          throw new CliHttpError(409, "revision_conflict", "stale", "trace_1");
        }).runModelSetup,
    };
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("\u001b[B");
    terminal.input("\u001b[B");
    terminal.input("\r");
    await vi.waitFor(() => { expect(profileLoads).toBe(1); });
    terminal.input("m");
    await terminal.waitForFrame("Reload required");
    const requestsAtConflict = setupRequests.length;

    resolvePreConflictReload?.();
    await terminal.waitForFrame("Model One");
    terminal.input("m");
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    expect(setupRequests).toHaveLength(requestsAtConflict);

    terminal.input("\r");
    await terminal.waitForFrame("Fresh Model");
    terminal.input("m");
    await vi.waitFor(() => { expect(setupRequests).toHaveLength(requestsAtConflict + 1); });
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
  });

  it("renders fixed safe text for non-conflict model setup failures", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const client = safeClient({
      adminRequest: async () => {
        throw new CliHttpError(503, "provider_unavailable", "provider-secret stale response", "trace-secret");
      },
    });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("m");
    await terminal.waitForFrame("Model setup is unavailable.");
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    const output = plainLines(terminal.frames.join("\n")).join("\n");
    expect(output).toContain("service_unavailable");
    expect(output).toContain("Model setup is unavailable.");
    expect(output).not.toContain("provider_unavailable");
    expect(output).not.toContain("provider-secret");
    expect(output).not.toContain("trace-secret");
  });

  it("waits for Ctrl+C to cancel active model setup without later polling or mutations", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
    const requests: { path: string; body: unknown }[] = [];
    let pollStarted: (() => void) | undefined;
    const pollStartedPromise = new Promise<void>((resolve) => { pollStarted = resolve; });
    const setupRequest = createSetupRequest(requests, () => "running");
    const setupCapability = modelSetupCapability(
      async <T>(path: string, init?: { readonly method?: string }) => {
        if (path === "/v1/admin/provider-drivers") return {
          piVersion: "0.73.1",
          drivers: [{
            driverId: "pi/openai",
            candidates: [{
              candidateId: "pi/openai:gpt-4.1-mini",
              displayName: "GPT-4.1 mini",
              modelId: "gpt-4.1-mini",
              credentialSupport: "bearer",
            }],
          }],
        } as T;
        const response = await setupRequest<T>(path, init);
        if (path === "/v1/admin/model-verifications/ver_1") pollStarted?.();
        return response;
      },
    );
    const client = safeClient({ runModelSetup: setupCapability.runModelSetup });
    const workbench = runWorkbench({ client, terminal });

    await terminal.ready();
    terminal.input("m");
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    terminal.input("\r");
    await terminal.waitForFrame("Provider slug");
    terminal.input("\r");
    await terminal.waitForFrame("Provider display name");
    terminal.input("\r");
    await terminal.waitForFrame("Base URL");
    terminal.input("\r");
    await terminal.waitForFrame("Catalog model");
    terminal.input("\r");
    await terminal.waitForFrame("Provider auth");
    terminal.input("\r");
    await terminal.waitForFrame("API key environment variable");
    terminal.input("OPENAI_API_KEY");
    terminal.input("\r");
    await terminal.waitForFrame("Model profile slug");
    terminal.input("\r");
    await terminal.waitForFrame("Model profile display name");
    terminal.input("\r");
    await terminal.waitForFrame("Context source");
    terminal.input("\r");
    await terminal.waitForFrame("Use resolved context limit");
    terminal.input("\r");
    await pollStartedPromise;
    const requestsAtCancel = requests.map((request) => request.path);
    terminal.input("\u0003");

    await expect(workbench).resolves.toBe(0);
    await new Promise<void>((resolve) => setTimeout(resolve, 300));
    expect(requests.map((request) => request.path)).toEqual(requestsAtCancel);
    expect(requests.some((request) => request.path.includes("/promotions"))).toBe(false);
    expect(requests.some((request) => request.path.includes("model-assignment"))).toBe(false);
  });

  it("cancels model setup polling before later Admin mutations", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const controller = new AbortController();
    let sleepStarted: (() => void) | undefined;
    const sleepStartedPromise = new Promise<void>((resolve) => { sleepStarted = resolve; });
    const outcome = runModelSetupScreen({
      client: setupClient(requests, () => "running"),
      prompt: scriptedPrompt({
        selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
        inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat"],
        confirmations: [true],
      }),
      write: vi.fn(),
      signal: controller.signal,
      sleep: async () => {
        sleepStarted?.();
        await new Promise<void>(() => undefined);
      },
    });

    await sleepStartedPromise;
    controller.abort();

    await expect(outcome).resolves.toEqual({ status: "cancelled" });
    expect(requests.some((request) => request.path.includes("/promotions"))).toBe(false);
    expect(requests.some((request) => request.path.includes("model-assignment"))).toBe(false);
  });

  it("stops the terminal once when startup fails", async () => {
    const terminal = new FakeTuiTerminal({ width: 120, height: 36, startError: new Error("terminal_start_failed") });

    await expect(runWorkbench({ client: safeClient(), terminal })).rejects.toThrow("terminal_start_failed");
    expect(terminal.stopCalls).toBe(1);
  });

  it("does not render credential-bearing multiline provider details", () => {
    const screen = new InspectorScreen();
    screen.showProblem({
      code: "provider_unavailable\u001b[31m",
      detail: "safe detail\nAuthorization: Bearer secret-value\nAPI key: hidden\ntoken=hidden\nshown",
      traceId: "t_1\u0007",
    });

    const text = screen.render(40).join("\n");
    expect(text).toContain("provider_unavailable");
    expect(text).toContain("shown");
    expect(text).not.toContain("Authorization");
    expect(text).not.toContain("Bearer");
    expect(text).not.toContain("API key");
    expect(text).not.toContain("hidden");
    expect(text).not.toContain("\u001b");
  });

  it("renders a reload-required conflict without server detail or trace content", () => {
    const screen = new InspectorScreen();
    screen.showConflict();

    const text = screen.render(80).join("\n");
    expect(text).toContain("Reload required");
    expect(text).not.toContain("provider-secret");
  });

  it("keeps the composed three-region layout within a narrow render width", async () => {
    const terminal = new FakeTuiTerminal({ width: 24, height: 36, inputs: ["\u0003"] });

    await runWorkbench({ client: safeClient(), terminal });

    for (const frame of terminal.frames) {
      for (const line of plainLines(frame)) {
        expect(visibleWidth(line)).toBeLessThanOrEqual(24);
      }
    }
  });
});

describe("model setup screen", () => {
  it("returns a reload requirement after one conflicting Promotion and clears review output", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const output: string[] = [];
    const setupRequest = createSetupRequest(requests);
    const client = modelSetupCapability(
      async <T>(path: string, init?: { readonly method?: string; readonly body?: unknown }) => {
        if (path.endsWith("/promotions")) {
          requests.push({ path, body: init?.body });
          throw new CliHttpError(409, "revision_conflict", "provider-secret stale response", "trace-secret");
        }
        return setupRequest<T>(path, init);
      },
    );
    const outcome = await runModelSetupScreen({
      client,
      prompt: scriptedPrompt({
        selects: ["deepseek", "pi/deepseek:deepseek-chat", "managed_secret", "preset"],
        inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "deepseek-chat", "DeepSeek Chat", ""],
        secrets: ["provider-secret"],
        confirmations: [true, false, true],
      }),
      write: (line) => output.push(line),
      sleep: async () => undefined,
    });

    expect(outcome).toEqual({ status: "conflict", reloadRequired: true });
    expect(requests.filter((request) => request.path.endsWith("/promotions"))).toHaveLength(1);
    expect(output.join("\n")).not.toContain("provider-secret");
  });

  it("does not convert unrelated HTTP failures into revision conflicts", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const setupRequest = createSetupRequest(requests);
    const client = modelSetupCapability(
      async <T>(path: string, init?: { readonly method?: string; readonly body?: unknown }) => {
        if (path.endsWith("/promotions")) {
          throw new CliHttpError(503, "provider_unavailable", "safe detail", "trace_1");
        }
        return setupRequest<T>(path, init);
      },
    );

    await expect(runModelSetupScreen({
      client,
      prompt: scriptedPrompt({
        selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
        inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", ""],
        confirmations: [true, false, true],
      }),
      write: vi.fn(),
      sleep: async () => undefined,
    })).rejects.toMatchObject({ code: "provider_unavailable" });
  });

  it("waits 250ms between verification reads by default", async () => {
    vi.useFakeTimers();
    try {
      const requests: { path: string; body: unknown }[] = [];
      let verificationReads = 0;
      const client = setupClient(requests, () => {
        verificationReads += 1;
        return verificationReads === 1 ? "running" : "passed";
      });
      const prompt = scriptedPrompt({
        selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
        inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", ""],
        confirmations: [true, false, false],
      });

      const outcome = runModelSetupScreen({ prompt, client, write: vi.fn() });
      await vi.advanceTimersByTimeAsync(249);
      expect(verificationReads).toBe(1);
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toEqual({ status: "cancelled" });
      expect(verificationReads).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("requires explicit promotion after successful verification", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const prompt = scriptedPrompt({
      selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat", ""],
      confirmations: [true, false, false],
    });

    const outcome = await runModelSetupScreen({ prompt, client: setupClient(requests), write: vi.fn(), sleep: async () => undefined });

    expect(outcome).toEqual({ status: "cancelled" });
    expect(requests.some((request) => request.path.endsWith("/promotions"))).toBe(false);
  });

  it("keeps Pi catalog candidates distinct from remote discovery and sends only Driver/Candidate identifiers", async () => {
    const requests: { path: string; body: unknown }[] = [];
    const selections: { message: string; choices: readonly unknown[] }[] = [];
    const prompt = scriptedPrompt({
      selects: ["deepseek", "pi/deepseek:deepseek-chat", "environment", "preset"],
      inputs: ["deepseek", "DeepSeek", "https://api.deepseek.com", "DEEPSEEK_API_KEY", "deepseek-chat", "DeepSeek Chat"],
      confirmations: [false],
      selections,
    });

    await runModelSetupScreen({ prompt, client: setupClient(requests), write: vi.fn(), sleep: async () => undefined });

    const catalog = selections.find((entry) => entry.message === "Catalog model");
    expect(catalog?.choices).toEqual([
      expect.objectContaining({ value: "pi/deepseek:deepseek-chat", label: expect.stringContaining("Pi catalog"), disabled: false }),
      expect.objectContaining({ value: "pi/deepseek:unsupported", label: expect.stringContaining("Pi catalog"), disabled: true }),
    ]);
    expect(selections.some((entry) => entry.message === "Discovered model")).toBe(false);
    expect(requests.find((request) => request.path === "/v1/admin/provider-connections")?.body)
      .toEqual(expect.objectContaining({ driverId: "pi/deepseek" }));
    expect(requests.find((request) => request.path === "/v1/admin/model-profiles")?.body)
      .toEqual(expect.objectContaining({ catalogCandidateId: "pi/deepseek:deepseek-chat" }));
  });
});

class FakeTuiTerminal implements Terminal {
  readonly frames: string[] = [];
  stopCalls = 0;
  private onInput: ((data: string) => void) | undefined;

  constructor(private readonly options: { readonly width: number; readonly height: number; readonly inputs?: readonly string[]; readonly startError?: Error }) {}

  start(onInput: (data: string) => void): void {
    if (this.options.startError !== undefined) throw this.options.startError;
    this.onInput = onInput;
    setTimeout(() => this.options.inputs?.forEach((input) => this.onInput?.(input)), 0);
  }

  input(data: string): void { this.onInput?.(data); }
  async ready(): Promise<void> { await new Promise<void>((resolve) => setTimeout(resolve, 0)); }
  async waitForFrame(value: string): Promise<void> {
    for (let attempt = 0; attempt < 20; attempt += 1) {
      if (this.frames.at(-1)?.includes(value) === true) return;
      await new Promise<void>((resolve) => setTimeout(resolve, 1));
    }
    throw new Error(`frame_not_found:${value}`);
  }

  stop(): void { this.stopCalls += 1; }
  async drainInput(): Promise<void> {}
  write(data: string): void { this.frames.push(`${this.frames.at(-1) ?? ""}${data}`); }
  get columns(): number { return this.options.width; }
  get rows(): number { return this.options.height; }
  get kittyProtocolActive(): boolean { return false; }
  moveBy(): void {}
  hideCursor(): void {}
  showCursor(): void {}
  clearLine(): void {}
  clearFromCursor(): void {}
  clearScreen(): void {}
  setTitle(): void {}
  setProgress(): void {}
}

function safeClient(overrides: Partial<{
  agents: readonly { readonly id: string; readonly displayName: string; readonly revisionId: string }[];
  connections: readonly { readonly connectionId: string; readonly displayName: string; readonly activeRevisionId: string | null; readonly retiredAt: string | null }[];
  profiles: readonly { readonly profileId: string; readonly displayName: string; readonly activeRevisionId: string | null; readonly retiredAt: string | null }[];
  adminRequest: <T>(path: string, init?: { readonly method?: string }) => Promise<T>;
  runModelSetup: ReturnType<typeof modelSetupCapability>["runModelSetup"];
  createRun: (input: { readonly agentId: string; readonly sessionKey: string; readonly text: string; readonly idempotencyKey?: string; readonly signal?: AbortSignal }) => Promise<{ readonly runId: string; readonly status: "queued"; readonly eventsUrl: string }>;
  stream: (path: string, lastEventId?: string, signal?: AbortSignal) => Promise<Response>;
  approvals: readonly ReturnType<typeof pendingApproval>[];
  listPendingApprovals: () => Promise<{ readonly approvals: readonly ReturnType<typeof pendingApproval>[] }>;
  decideApproval: (approvalId: string, decision: "approve" | "deny") => Promise<{ readonly approvalId: string; readonly runId: string; readonly state: "approved" | "denied"; readonly resolvedAt: string | null }>;
}> = {}) {
  return {
    listAgents: async () => ({ agents: overrides.agents ?? [{ id: "research", displayName: "Research Agent", revisionId: "rev_1" }], unavailable: [] }),
    listProviderConnections: async () => ({ connections: overrides.connections ?? [{ connectionId: "provider-one", displayName: "Provider One", activeRevisionId: "pcr_1", retiredAt: null }] }),
    listModelProfiles: async () => ({ profiles: overrides.profiles ?? [{ profileId: "model-one", displayName: "Model One", activeRevisionId: "mpr_1", retiredAt: null }] }),
    listProviderDrivers: async () => ({ piVersion: "0.73.1" as const, drivers: [] }),
    runModelSetup: overrides.runModelSetup ?? modelSetupCapability(
      overrides.adminRequest ?? (async <T>(path: string) => (path === "/v1/admin/provider-drivers"
        ? { piVersion: "0.73.1", drivers: [] } as T
        : {} as T)),
    ).runModelSetup,
    createRun: overrides.createRun ?? (async () => ({ runId: "run_1", status: "queued", eventsUrl: "/v1/runs/run_1/events" })),
    stream: overrides.stream ?? (async () => sseResponse([eventFrame(1, "run.completed", { result: null })])),
    listPendingApprovals: overrides.listPendingApprovals ?? (async () => ({ approvals: overrides.approvals ?? [] })),
    decideApproval: overrides.decideApproval ?? (async (approvalId, decision) => ({
      approvalId,
      runId: "run_1",
      state: decision === "approve" ? "approved" : "denied",
      resolvedAt: "2026-08-12T00:00:00.000Z",
    })),
  };
}

async function navigateWorkbench(
  client: Parameters<typeof runWorkbench>[0]["client"],
  keys: readonly string[],
  expected: string,
): Promise<void> {
  const terminal = new FakeTuiTerminal({ width: 120, height: 36 });
  const workbench = runWorkbench({ client, terminal });
  await terminal.ready();
  for (const key of keys) terminal.input(key);
  terminal.input("\r");
  await terminal.waitForFrame(expected);
  terminal.input("\u0003");
  await expect(workbench).resolves.toBe(0);
}

function modelProfileView(): ModelProfileResponse {
  return {
    profileId: "model-one",
    displayName: "Model One",
    activeRevisionId: "mpr_verified",
    retiredAt: null,
    recordRevision: 2,
    revisions: [{
      revisionId: "mpr_verified",
      profileId: "model-one",
      connectionRevisionId: "pcr_one",
      providerModelId: "model-one",
      invocationProtocol: "responses" as const,
      maxInputTokens: 128_000,
      contextWindowSource: "preset" as const,
      capabilityBaseline: "text_and_single_tool_call_v1" as const,
      verifiedCapabilities: ["streaming_text", "single_tool_call"],
      state: "verified" as const,
      createdAt: "2026-08-13T00:00:00.000Z",
    }],
  };
}

function providerConnectionView() {
  return {
    connectionId: "provider-one",
    displayName: "Provider One",
    providerKind: "openai" as const,
    providerDriver: "pi/openai",
    activeRevisionId: "pcr_one",
    retiredAt: null,
    recordRevision: 1,
    credentialConfigured: true,
    revisions: [{
      revisionId: "pcr_one",
      connectionId: "provider-one",
      state: "active" as const,
      baseUrl: "https://api.openai.com/v1",
      allowInsecureHttp: false,
      protocolPreference: "responses" as const,
      presetVersion: "2026-08-01",
      credentialConfigured: true,
      createdAt: "2026-08-13T00:00:00.000Z",
    }],
  };
}

function verificationView(status: "running" | "cancelled", recordRevision: number) {
  return {
    verificationId: "ver_one",
    profileRevisionId: "mpr_verified",
    capabilityBaseline: "text_and_single_tool_call_v1" as const,
    status,
    resultCode: null,
    safeStatus: null,
    capabilities: [],
    traceId: "trace_one",
    recordRevision,
    createdAt: "2026-08-13T00:00:00.000Z",
    updatedAt: "2026-08-13T00:00:00.000Z",
    cancellationRequestedAt: null,
    fallbackProfileRevisionId: null,
    fallbackVerificationId: null,
  };
}

function pendingApproval() {
  return {
    approvalId: "apr_1",
    runId: "run_1",
    toolCallId: "tool_1",
    state: "pending" as const,
    toolName: "write_file",
    arguments: { path: "status.txt" },
    expiresAt: "2026-08-13T00:00:00.000Z",
  };
}

function sseResponse(chunks: readonly string[]): Response {
  const encoder = new TextEncoder();
  return new Response(new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function interruptedSseResponse(frame: string): Response {
  const encoder = new TextEncoder();
  let reads = 0;
  return new Response(new ReadableStream<Uint8Array>({
    pull(controller) {
      if (reads++ === 0) controller.enqueue(encoder.encode(frame));
      else controller.error(new TypeError("network socket closed"));
    },
  }), { headers: { "content-type": "text/event-stream" } });
}

function eventFrame(sequence: number, type: string, payload: unknown): string {
  return `id: ${String(sequence)}\nevent: ${type}\ndata: ${JSON.stringify({
    runId: "run_1",
    sequence,
    type,
    occurredAt: "2026-08-12T00:00:00.000Z",
    payload,
  })}\n\n`;
}


function plainLines(frame: string): string[] {
  let text = "";
  for (let index = 0; index < frame.length; index += 1) {
    if (frame.charCodeAt(index) !== 0x1b) {
      text += frame[index]!;
      continue;
    }
    const next = frame[index + 1];
    if (next === "[") {
      index += 2;
      while (index < frame.length && !isAnsiTerminator(frame[index]!)) index += 1;
    } else if (next === "]") {
      index += 2;
      while (index < frame.length && frame.charCodeAt(index) !== 0x07) index += 1;
    }
  }
  return text.split(/\r?\n/u);
}

function isAnsiTerminator(character: string): boolean {
  const code = character.charCodeAt(0);
  return code >= 0x40 && code <= 0x7e;
}

function scriptedPrompt(values: {
  selects: string[];
  inputs: string[];
  secrets?: string[];
  confirmations: boolean[];
  selections?: { message: string; choices: readonly unknown[] }[];
}): CliPrompt {
  return {
    select: async <T extends string>(message: string, choices: readonly unknown[]) => {
      values.selections?.push({ message, choices });
      return values.selects.shift() as T;
    },
    selectChoice: async <T extends string>(message: string, choices: readonly unknown[]) => {
      values.selections?.push({ message, choices });
      return values.selects.shift() as T;
    },
    input: async () => values.inputs.shift() ?? "",
    secret: async () => values.secrets?.shift() ?? Promise.reject(new Error("unexpected_secret_prompt")),
    confirm: async () => values.confirmations.shift() ?? false,
  } as CliPrompt;
}

function setupClient(
  requests: { path: string; body: unknown }[],
  verificationStatus: () => "running" | "passed" = () => "passed",
) {
  return modelSetupCapability(createSetupRequest(requests, verificationStatus));
}

function createSetupRequest(
  requests: { path: string; body: unknown }[],
  verificationStatus: () => "running" | "passed" = () => "passed",
): AdminClient["request"] {
  return async <T>(path: string, options: { method?: string; body?: unknown } = {}) => {
      requests.push({ path, body: options.body });
      if (path === "/v1/admin/provider-drivers") return {
        piVersion: "0.73.1",
        drivers: [{
          driverId: "pi/deepseek",
          candidates: [
            { candidateId: "pi/deepseek:deepseek-chat", displayName: "DeepSeek Chat", modelId: "deepseek-chat", credentialSupport: "bearer" },
            { candidateId: "pi/deepseek:unsupported", displayName: "Unsupported", modelId: "unsupported", credentialSupport: "unsupported" },
          ],
        }],
      } as T;
      if (path === "/v1/admin/provider-connections") return { recordRevision: 0, revisions: [{ revisionId: "pcr_1", baseUrl: "https://api.deepseek.com/v1", protocolPreference: "responses" }] } as T;
      if (path.endsWith("/discover")) return { recordRevision: 1, state: "fresh", models: [{ id: "remote-only" }], error: null } as T;
      if (path === "/v1/admin/model-profiles") return { profileId: "deepseek-chat", recordRevision: 0, revisions: [{ revisionId: "mpr_1", invocationProtocol: "responses", maxInputTokens: 65536, contextWindowSource: "preset" }] } as T;
      if (path.endsWith("/verifications")) return { operationUrl: "/v1/admin/model-verifications/ver_1" } as T;
      if (path === "/v1/admin/model-verifications/ver_1") return { verificationId: "ver_1", profileRevisionId: "mpr_1", status: verificationStatus(), resultCode: null, capabilities: [], traceId: "trace", fallbackProfileRevisionId: null, fallbackVerificationId: null } as T;
      if (path === "/v1/admin/model-profiles/deepseek-chat") return { profileId: "deepseek-chat", recordRevision: 1, revisions: [{ revisionId: "mpr_1", invocationProtocol: "responses", maxInputTokens: 65536, contextWindowSource: "preset" }] } as T;
      return {} as T;
    };
}

function modelSetupCapability(request: AdminClient["request"]) {
  return {
    runModelSetup: (input: {
      readonly prompt: CliPrompt;
      readonly sleep: (milliseconds: number) => Promise<void>;
      readonly write: (line: string) => void;
      readonly onProgress?: SetupModelProgressCallback;
      readonly signal?: AbortSignal;
    }) => setupModel(
      {
        request: <T>(path: string, init?: Parameters<AdminClient["request"]>[1]) => input.signal?.aborted === true
          ? Promise.reject(new CliPromptCancelledError())
          : request<T>(path, init),
      },
      input.prompt,
      input.sleep,
      input.write,
      true,
      input.onProgress,
    ),
  };
}
