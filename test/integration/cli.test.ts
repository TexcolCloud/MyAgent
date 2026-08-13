import { randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { fileURLToPath } from "node:url";

import type { DatabaseSync } from "node:sqlite";
import type { FastifyInstance } from "fastify";

import { startTestApp } from "../helpers/start-test-app.js";
import { tempPath } from "../helpers/temp-dir.js";

describe("CLI HTTP boundary", () => {
  it("keeps public help focused on the TUI-first entry points", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];

    await expect(executeCli(["--help"], {
      write: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(output).toEqual([
      "myagent",
      "tui",
      "serve",
      "config validate",
      "doctor",
      "backup",
    ]);
  });

  it("keeps deprecated resource commands executable with one stderr notice and clean JSON stdout", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const stdout: string[] = [];
    const stderr: string[] = [];

    await expect(executeCli(["agents", "list", "--json"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "run-token",
      },
      fetcher: async () => Response.json({ catalogRevision: "catalog", agents: [], unavailable: [] }),
      write: (line) => stdout.push(line),
      writeError: (line) => stderr.push(line),
    })).resolves.toBe(0);

    expect(JSON.parse(stdout[0]!)).toEqual({ catalogRevision: "catalog", agents: [], unavailable: [] });
    expect(stderr).toEqual(["deprecated_command: This command is deprecated; use the TUI or /v1 HTTP Automation Surface."]);
  });

  it("adapts deprecated Run cancellation to the confirmed revisioned HTTP contract", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const stdout: string[] = [];
    const stderr: string[] = [];
    const requests: Array<{ method: string; path: string; body: unknown }> = [];

    await expect(executeCli(["run", "cancel", "run_1", "--json"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "run-token",
      },
      fetcher: async (input, init) => {
        const url = new URL(String(input));
        requests.push({
          method: init?.method ?? "GET",
          path: url.pathname,
          body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
        });
        return Response.json(
          init?.method === "POST"
            ? { runId: "run_1", status: "cancelled" }
            : { runId: "run_1", updatedAt: "2026-08-13T00:00:00.000Z" },
        );
      },
      write: (line) => stdout.push(line),
      writeError: (line) => stderr.push(line),
    })).resolves.toBe(0);

    expect(requests).toEqual([
      { method: "GET", path: "/v1/runs/run_1", body: undefined },
      {
        method: "POST",
        path: "/v1/runs/run_1/cancel",
        body: { confirm: true, expectedRevision: "2026-08-13T00:00:00.000Z" },
      },
    ]);
    expect(JSON.parse(stdout[0]!)).toEqual({ runId: "run_1", status: "cancelled" });
    expect(stderr).toEqual(["deprecated_command: This command is deprecated; use the TUI or /v1 HTTP Automation Surface."]);
  });

  it("requires the explicit internal spelling for recovery commands", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const requests: Array<{ path: string; authorization: string | null }> = [];
    const options = {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "run-token",
        MYAGENT_ADMIN_TOKEN: "admin-token",
      },
      fetcher: async (input: string | URL | Request, init?: RequestInit) => {
        const url = new URL(String(input));
        requests.push({
          path: url.pathname,
          authorization: new Headers(init?.headers).get("authorization"),
        });
        return Response.json({ ok: true });
      },
      write: (line: string) => output.push(line),
    };

    await expect(executeCli(["config", "reload"], options)).resolves.toBe(2);
    await expect(executeCli(["internal", "config", "reload"], options)).resolves.toBe(0);
    await expect(executeCli(["internal", "tools", "reconcile", "tool_1", "--as", "retry"], options)).resolves.toBe(0);
    await expect(executeCli(["internal", "secrets", "rotate-master-key", "--expected-revision", "4"], options)).resolves.toBe(0);

    expect(requests).toEqual([
      { path: "/v1/config/reload", authorization: "Bearer run-token" },
      { path: "/v1/tool-calls/tool_1/reconciliation", authorization: "Bearer run-token" },
      { path: "/v1/admin/managed-secrets/master-key-rotation", authorization: "Bearer admin-token" },
    ]);
  });

  it.each([[[]], [["tui"]], [["tui", "--local"]]])(
    "routes %j to a workspace-scoped Local Integrated Host",
    async (argumentsList) => {
      const { executeCli } = await import("../../src/interfaces/cli/main.js");
      const workspace = tempPath(`cli-local-ready-${randomUUID()}`);
      const runLocalHost = vi.fn(async () => 0);

      await expect(executeCli(argumentsList, {
        workspace,
        stdinIsTTY: true,
        stdoutIsTTY: true,
        inspectProjectState: async () => "ready",
        runLocalHost,
      })).resolves.toBe(0);

      expect(runLocalHost).toHaveBeenCalledWith({
        configPath: path.join(workspace, ".myagent", "myagent.yaml"),
        projectStateRoot: path.join(workspace, ".myagent"),
      });
    },
  );

  it("rejects a missing noncanonical local config before inspection or initialization", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-init-${randomUUID()}`);
    const configPath = path.join(workspace, "controlled", "local.yaml");
    const inspectProjectState = vi.fn(async () => "absent" as const);
    const initializeProjectState = vi.fn(async () => undefined);
    const runLocalHost = vi.fn(async () => 0);
    const confirm = vi.fn(async () => true);
    const stderr: string[] = [];

    await expect(executeCli(["tui", "--config", configPath], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState,
      initializeProjectState,
      prompt: {
        select: async () => { throw new Error("unexpected_select"); },
        input: async () => { throw new Error("unexpected_input"); },
        secret: async () => { throw new Error("unexpected_secret"); },
        confirm,
      },
      runLocalHost,
      writeError: (line) => stderr.push(line),
    })).resolves.toBe(2);

    expect(stderr).toEqual([
      "local_config_outside_project_state: Local configuration must use Workspace-owned Project Agent State. (traceId: cli)",
    ]);
    expect(inspectProjectState).not.toHaveBeenCalled();
    expect(initializeProjectState).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
    expect(runLocalHost).not.toHaveBeenCalled();
  });

  it("initializes an explicitly selected canonical local config", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-canonical-${randomUUID()}`);
    const configPath = path.join(workspace, ".myagent", "myagent.yaml");
    const initializeProjectState = vi.fn(async () => undefined);
    const runLocalHost = vi.fn(async () => 0);

    await expect(executeCli(["tui", "--config", configPath], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState: async () => "absent",
      initializeProjectState,
      prompt: {
        select: async () => { throw new Error("unexpected_select"); },
        input: async () => { throw new Error("unexpected_input"); },
        secret: async () => { throw new Error("unexpected_secret"); },
        confirm: async () => true,
      },
      runLocalHost,
    })).resolves.toBe(0);

    expect(initializeProjectState).toHaveBeenCalledTimes(1);
    expect(runLocalHost).toHaveBeenCalledWith({
      configPath,
      projectStateRoot: path.join(workspace, ".myagent"),
    });
  });

  it("rejects a linked local state root before any local state action", async (context) => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-linked-root-${randomUUID()}`);
    const outside = tempPath(`cli-local-linked-root-outside-${randomUUID()}`);
    await mkdir(workspace, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    try {
      await symlink(outside, path.join(workspace, ".myagent"), "junction");
    } catch (error) {
      if (!hasCode(error, "EPERM") && !hasCode(error, "EACCES")) throw error;
      context.skip(`junction creation unavailable: ${String((error as Error).message)}`);
    }
    const inspectProjectState = vi.fn(async () => "ready" as const);
    const runLocalHost = vi.fn(async () => 0);

    await expect(executeCli([], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState,
      runLocalHost,
      writeError: () => {},
    })).resolves.toBe(2);

    expect(inspectProjectState).not.toHaveBeenCalled();
    expect(runLocalHost).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it.each([
    {
      name: "incompatible",
      database: "state.sqlite",
      agentRoots: ["agents"],
      skillRoots: ["skills"],
      expectedExit: 2,
    },
    {
      name: "compatible",
      database: "../.myagent/state.sqlite",
      agentRoots: ["../.myagent/agents"],
      skillRoots: ["../.myagent/skills"],
      expectedExit: 0,
    },
  ])("handles an $name existing explicit local config before host startup", async ({
    database,
    agentRoots,
    skillRoots,
    expectedExit,
  }) => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-explicit-${randomUUID()}`);
    const configPath = path.join(workspace, "controlled", "local.yaml");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, [
      "version: 2",
      "server:",
      "  bearerToken: { fromEnvironment: RUN_TOKEN }",
      "  adminToken: { fromEnvironment: ADMIN_TOKEN }",
      "database:",
      `  path: ${database}`,
      "agentRoots:",
      ...agentRoots.map((root) => `  - ${root}`),
      "skillRoots:",
      ...skillRoots.map((root) => `  - ${root}`),
      "toolEnvironmentAllowlist: []",
      "",
    ].join("\n"));
    const inspectProjectState = vi.fn(async () => "ready" as const);
    const runLocalHost = vi.fn(async () => 0);

    await expect(executeCli(["tui", "--config", configPath], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState,
      runLocalHost,
      writeError: () => {},
    })).resolves.toBe(expectedExit);

    if (expectedExit === 0) {
      expect(runLocalHost).toHaveBeenCalledWith({
        configPath,
        projectStateRoot: path.join(workspace, ".myagent"),
      });
    } else {
      expect(inspectProjectState).not.toHaveBeenCalled();
      expect(runLocalHost).not.toHaveBeenCalled();
    }
  });

  it("rejects a linked durable path in an otherwise compatible explicit config", async (context) => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-linked-agents-${randomUUID()}`);
    const root = path.join(workspace, ".myagent");
    const outside = tempPath(`cli-local-linked-agents-outside-${randomUUID()}`);
    const configPath = path.join(workspace, "controlled", "local.yaml");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    try {
      await symlink(outside, path.join(root, "agents"), "junction");
    } catch (error) {
      if (!hasCode(error, "EPERM") && !hasCode(error, "EACCES")) throw error;
      context.skip(`junction creation unavailable: ${String((error as Error).message)}`);
    }
    await writeFile(configPath, [
      "version: 2",
      "server:",
      "  bearerToken: { fromEnvironment: RUN_TOKEN }",
      "  adminToken: { fromEnvironment: ADMIN_TOKEN }",
      "database: { path: ../.myagent/state.sqlite }",
      "agentRoots: [../.myagent/agents]",
      "skillRoots: [../.myagent/skills]",
      "toolEnvironmentAllowlist: []",
      "",
    ].join("\n"));
    const inspectProjectState = vi.fn(async () => "ready" as const);
    const runLocalHost = vi.fn(async () => 0);

    await expect(executeCli(["tui", "--config", configPath], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState,
      runLocalHost,
      writeError: () => {},
    })).resolves.toBe(2);

    expect(inspectProjectState).not.toHaveBeenCalled();
    expect(runLocalHost).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it("rejects a dangling local database link before host startup", async (context) => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-dangling-db-${randomUUID()}`);
    const root = path.join(workspace, ".myagent");
    const outside = tempPath(`cli-local-dangling-db-outside-${randomUUID()}`);
    const missingTarget = path.join(outside, "missing.sqlite");
    await mkdir(root, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, "keep.txt"), "keep\n");
    await writeFile(path.join(root, "myagent.yaml"), [
      "version: 2",
      "server:",
      "  bearerToken: { fromEnvironment: RUN_TOKEN }",
      "  adminToken: { fromEnvironment: ADMIN_TOKEN }",
      "database: { path: state.sqlite }",
      "agentRoots: [agents]",
      "skillRoots: [skills]",
      "toolEnvironmentAllowlist: []",
      "",
    ].join("\n"));
    try {
      await symlink(missingTarget, path.join(root, "state.sqlite"), "file");
    } catch (error) {
      if (!hasCode(error, "EPERM") && !hasCode(error, "EACCES")) throw error;
      context.skip(`file symlink creation unavailable: ${String((error as Error).message)}`);
    }
    expect((await lstat(path.join(root, "state.sqlite"))).isSymbolicLink()).toBe(true);
    const inspectProjectState = vi.fn(async () => "ready" as const);
    const runLocalHost = vi.fn(async () => 0);

    await expect(executeCli([], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState,
      runLocalHost,
      writeError: () => {},
    })).resolves.toBe(2);

    expect(inspectProjectState).not.toHaveBeenCalled();
    expect(runLocalHost).not.toHaveBeenCalled();
    expect(await readdir(outside)).toEqual(["keep.txt"]);
  });

  it("fails noninteractively before creating absent project state", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-noninteractive-${randomUUID()}`);
    const initializeProjectState = vi.fn(async () => undefined);

    await expect(executeCli([], {
      workspace,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      initializeProjectState,
    })).resolves.toBe(2);

    expect(initializeProjectState).not.toHaveBeenCalled();
    await expect(stat(path.join(workspace, ".myagent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not initialize project state when first-run consent is declined", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-declined-${randomUUID()}`);
    const initializeProjectState = vi.fn(async () => undefined);

    await expect(executeCli([], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      inspectProjectState: async () => "absent",
      initializeProjectState,
      prompt: {
        select: async () => { throw new Error("unexpected_select"); },
        input: async () => { throw new Error("unexpected_input"); },
        secret: async () => { throw new Error("unexpected_secret"); },
        confirm: async () => false,
      },
    })).resolves.toBe(2);

    expect(initializeProjectState).not.toHaveBeenCalled();
    await expect(stat(path.join(workspace, ".myagent"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects partial local state without initializing or starting a host", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const workspace = tempPath(`cli-local-partial-${randomUUID()}`);
    const root = path.join(workspace, ".myagent");
    await mkdir(root, { recursive: true });
    await writeFile(path.join(root, "myagent.yaml"), "version: 2\n");
    const initializeProjectState = vi.fn(async () => undefined);
    const runLocalHost = vi.fn(async () => 0);

    await expect(executeCli([], {
      workspace,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      initializeProjectState,
      runLocalHost,
    })).resolves.toBe(2);

    expect(initializeProjectState).not.toHaveBeenCalled();
    expect(runLocalHost).not.toHaveBeenCalled();
  });

  it("rejects ambiguous local and attached syntax before acquiring credentials", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const prompt = {
      select: vi.fn(), input: vi.fn(), secret: vi.fn(), confirm: vi.fn(),
    };

    await expect(executeCli([
      "tui", "--local", "--api-url", "http://127.0.0.1:8787",
    ], { stdinIsTTY: true, stdoutIsTTY: true, prompt })).resolves.toBe(2);

    expect(prompt.secret).not.toHaveBeenCalled();
  });

  it("attaches to a normalized loopback origin without probing and reports credential sources", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const fetcher = vi.fn();
    const runTui = vi.fn();

    await expect(executeCli(["tui", "--api-url", "http://127.0.0.1:8787"], {
      environment: { MYAGENT_RUN_TOKEN: "run-secret", MYAGENT_ADMIN_TOKEN: "admin-secret" },
      fetcher,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      runTui,
      write: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(fetcher).not.toHaveBeenCalled();
    expect(runTui).toHaveBeenCalledOnce();
    expect(output).toEqual([
      "Origin: http://127.0.0.1:8787",
      "TLS: disabled",
      "Run credential source: environment",
      "Admin credential source: environment",
    ]);
    expect(output.join("\n")).not.toContain("run-secret");
    expect(output.join("\n")).not.toContain("admin-secret");
  });

  it("requires an override and exact normalized-origin confirmation for remote attachment", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const origin = "https://example.com";
    const environment = { MYAGENT_RUN_TOKEN: "run-secret", MYAGENT_ADMIN_TOKEN: "admin-secret" };
    const runTui = vi.fn();
    const secret = vi.fn();

    const credentialHelper = vi.fn(async () => ({ runToken: "helper-run", adminToken: "helper-admin" }));
    await expect(executeCli(["tui", "--api-url", `${origin}:443`], {
      environment: {}, credentialHelper, stdinIsTTY: true, stdoutIsTTY: true, runTui,
    })).resolves.toBe(2);
    expect(credentialHelper).not.toHaveBeenCalled();
    await expect(executeCli(["tui", "--api-url", `${origin}:443`, "--allow-remote"], {
      environment,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: {
        select: async () => { throw new Error("unexpected_select"); },
        input: async () => `${origin}:443`,
        secret,
        confirm: async () => false,
      },
      runTui,
    })).resolves.toBe(2);
    await expect(executeCli(["tui", "--api-url", `${origin}:443`, "--allow-remote"], {
      environment,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      prompt: {
        select: async () => { throw new Error("unexpected_select"); },
        input: async () => origin,
        secret,
        confirm: async () => false,
      },
      runTui,
    })).resolves.toBe(0);

    expect(secret).not.toHaveBeenCalled();
    expect(runTui).toHaveBeenCalledOnce();
  });

  it("preserves root myagent.yaml defaults for serve and config validate", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const serveService = vi.fn(async () => undefined);
    const validateConfiguration = vi.fn(async () => undefined);

    await expect(executeCli(["serve"], { serveService })).resolves.toBe(0);
    await expect(executeCli(["config", "validate"], { validateConfiguration })).resolves.toBe(0);

    expect(serveService).toHaveBeenCalledWith("myagent.yaml");
    expect(validateConfiguration).toHaveBeenCalledWith("myagent.yaml", expect.any(Function));
  });
  it("returns one Problem and does not invoke the TUI boundary without an interactive terminal", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const runTui = vi.fn();

    await expect(executeCli(["tui"], {
      stdinIsTTY: false,
      stdoutIsTTY: false,
      runTui,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(2);

    expect(output).toEqual([
      "interactive_tty_required: An interactive TTY is required. (traceId: cli)",
    ]);
    expect(runTui).not.toHaveBeenCalled();
  });

  it("validates TUI flags before acquiring the terminal and keeps configured tokens out of output", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const environment = {
      MYAGENT_RUN_TOKEN: "run-token-must-not-appear",
      MYAGENT_ADMIN_TOKEN: "admin-token-must-not-appear",
    };
    const runTui = vi.fn();

    await expect(executeCli(["tui", "--unsupported", "value"], {
      environment,
      stdinIsTTY: false,
      stdoutIsTTY: false,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(2);
    await expect(executeCli(["tui", "--api-url", "http://127.0.0.1:8787"], {
      environment,
      stdinIsTTY: true,
      stdoutIsTTY: true,
      runTui,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(0);

    expect(output).toEqual([
      "invalid_cli_command: The CLI command is invalid. (traceId: cli)",
      "Origin: http://127.0.0.1:8787",
      "TLS: disabled",
      "Run credential source: environment",
      "Admin credential source: environment",
    ]);
    expect(runTui).toHaveBeenCalledOnce();
    expect(output.join("\n")).not.toContain("token");
  });

  it("rejects visible TUI tokens without creating a workbench", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const output: string[] = [];
    const runTui = vi.fn();

    await expect(executeCli(["tui", "--token", "run-override", "--admin-token", "admin-override"], {
      environment: { MYAGENT_RUN_TOKEN: "run-environment", MYAGENT_ADMIN_TOKEN: "admin-environment" },
      stdinIsTTY: true,
      stdoutIsTTY: true,
      runTui,
      write: (line) => output.push(line),
      writeError: (line) => output.push(line),
    })).resolves.toBe(2);

    expect(output).toEqual(["visible_tui_token_forbidden: Use TUI environment variables or masked prompts for tokens. (traceId: cli)"]);
    expect(runTui).not.toHaveBeenCalled();
    expect(output.join("\n")).not.toContain("run-override");
    expect(output.join("\n")).not.toContain("admin-override");
  });

  it("loads local config validation without importing SQLite", async () => {
    vi.resetModules();
    vi.doMock("node:sqlite", () => {
      throw new Error("cli_imported_sqlite");
    });
    try {
      const { executeCli } = await import("../../src/interfaces/cli/main.js");
      const fetcher = vi.fn();
      const write = vi.fn();
      const configPath = fileURLToPath(new URL("../fixtures/config/valid/myagent.yaml", import.meta.url));

      await executeCli(["config", "validate", "--config", configPath], { fetcher, write });

      expect(fetcher).not.toHaveBeenCalled();
      expect(write).toHaveBeenCalledWith(expect.stringContaining("primary"));
    } finally {
      vi.doUnmock("node:sqlite");
      vi.resetModules();
    }
  });

  it("runs every operational command through the authenticated HTTP API", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const harness = await startTestApp();
    const output: string[] = [];
    let watchRequests = 0;
    const fetcher = injectFetcher(harness.app, (url) => {
      if (url.pathname.endsWith("/events")) {
        watchRequests += 1;
        if (watchRequests > 1) throw new Error("unexpected_terminal_reconnect");
      }
    });
    const options = {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "test-token",
      },
      fetcher,
      write: (line: string) => { output.push(line); },
    };
    const call = async (
      argumentsList: string[],
      deprecated = false,
    ): Promise<void> => {
      const stderr: string[] = [];
      await expect(executeCli(argumentsList, {
        ...options,
        writeError: (line) => stderr.push(line),
      })).resolves.toBe(0);
      expect(stderr).toEqual(deprecated
        ? ["deprecated_command: This command is deprecated; use the TUI or /v1 HTTP Automation Surface."]
        : []);
    };

    try {
      await call(["agents", "list"], true);
      await call(["internal", "config", "reload"]);
      await call(["run", "create", "--agent", "primary", "--session", "cli:test", "--text", "hello"], true);
      const created = JSON.parse(output.at(-1)!) as { runId: string };
      const sessionId = harness.runs.getRun(created.runId as never).sessionId;

      await call(["run", "cancel", created.runId], true);
      await call(["run", "watch", created.runId], true);
      await call(["sessions", "list", "--agent", "primary", "--session", "cli:test"], true);

      const approvalRunA = await createRun(harness.app, "cli:approval:a", "cli-approval-request-a");
      const approvalRunB = await createRun(harness.app, "cli:approval:b", "cli-approval-request-b");
      seedPendingApproval(harness.connection.db, approvalRunA, "a");
      seedPendingApproval(harness.connection.db, approvalRunB, "b");
      await call(["approvals", "list"], true);
      const approvalList = JSON.parse(output.at(-1)!) as { approvals: unknown[] };
      await call(["approvals", "approve", "approval-cli-a"], true);
      await call(["approvals", "deny", "approval-cli-b"], true);

      for (const outcome of ["succeeded", "failed", "retry"] as const) {
        const runId = await createRun(harness.app, `cli:reconcile:${outcome}`, `cli-reconcile-${outcome}`);
        seedUnknownToolCall(harness.connection.db, runId, outcome);
        await call(["internal", "tools", "reconcile", `tool-cli-${outcome}`, "--as", outcome]);
      }

      await call(["sessions", "delete", sessionId], true);
      const backupDestination = tempPath(`cli-backup-${randomUUID()}`);
      await call(["backup", backupDestination]);

      expect(watchRequests).toBe(1);
      expect(approvalList.approvals).toEqual(expect.arrayContaining([
        expect.objectContaining({
          approvalId: "approval-cli-a",
          toolName: "run_command",
          arguments: { args: ["hello"], program: "node" },
          riskNotice: "This command runs on the host and is not isolated by an OS sandbox.",
        }),
      ]));
      expect(output.some((line) => line.includes('"database":"kernel.db"'))).toBe(true);
    } finally {
      await harness.close();
    }
  }, 15_000);

  it("stops watching after a terminal Run event", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const completed = JSON.stringify({
      runId: "run-cli-1",
      sequence: 9,
      type: "run.completed",
      occurredAt: "2026-08-12T00:00:00.000Z",
      payload: { result: { type: "text", text: "done" } },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        `id: 9\nevent: run.completed\ndata: ${completed}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ))
      .mockRejectedValue(new Error("unexpected_terminal_reconnect"));
    const write = vi.fn();

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      write,
    })).resolves.toBe(0);

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(write).toHaveBeenCalledWith(completed);
  });

  it("preserves validated noncanonical SSE data when watching a Run", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const completed = [
      "{",
      ' "type" : "run.completed", "payload" : {},',
      ' "occurredAt" : "2026-08-12T00:00:00.000Z", "sequence" : 9, "runId" : "run-cli-1"',
      "}",
    ].join("\n");
    const data = completed.split("\n").map((line) => `data: ${line}`).join("\n");
    const write = vi.fn();

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher: async () => new Response(
        `id: 9\nevent: run.completed\n${data}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      write,
    })).resolves.toBe(0);

    expect(write).toHaveBeenCalledWith(completed);
  });

  it("fails a Run watch with the existing credential exit when its token is absent", async () => {
    const { CliClient } = await import("../../src/interfaces/cli/client.js");
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const originalStream = CliClient.prototype.stream;
    let attempts = 0;
    const stream = vi.spyOn(CliClient.prototype, "stream").mockImplementation(function (this: InstanceType<typeof CliClient>, ...args) {
      attempts += 1;
      if (attempts === 1) return originalStream.apply(this, args);
      return Promise.resolve(new Response(
        "id: 1\nevent: run.completed\ndata: {\"runId\":\"run-cli-1\",\"sequence\":1,\"type\":\"run.completed\",\"occurredAt\":\"2026-08-12T00:00:00.000Z\",\"payload\":{}}\n\n",
        { status: 200 },
      ));
    });
    try {
      await expect(executeCli(["run", "watch", "run-cli-1"], {
        environment: { MYAGENT_API_URL: "http://127.0.0.1:8787" },
        writeError: () => undefined,
      })).resolves.toBe(3);
      expect(stream).toHaveBeenCalledOnce();
    } finally {
      stream.mockRestore();
    }
  });

  it("fails a Run watch with the existing service exit after one fetch rejection", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const fetcher = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValue(new Response(
        "id: 1\nevent: run.completed\ndata: {\"runId\":\"run-cli-1\",\"sequence\":1,\"type\":\"run.completed\",\"occurredAt\":\"2026-08-12T00:00:00.000Z\",\"payload\":{}}\n\n",
        { status: 200 },
      ));

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      writeError: () => undefined,
    })).resolves.toBe(6);
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it("returns after a non-terminal stream EOF without reconnecting", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const delta = JSON.stringify({
      runId: "run-cli-1",
      sequence: 4,
      type: "message.delta",
      occurredAt: "2026-08-12T00:00:00.000Z",
      payload: { text: "hello" },
    });
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(
        `id: 4\nevent: message.delta\ndata: ${delta}\n\n`,
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ))
      .mockRejectedValue(new Error("unexpected_eof_reconnect"));
    const write = vi.fn();

    await expect(executeCli(["run", "watch", "run-cli-1"], {
      environment: {
        MYAGENT_API_URL: "http://127.0.0.1:8787",
        MYAGENT_BEARER_TOKEN: "operator-token",
      },
      fetcher,
      write,
    })).resolves.toBe(0);

    expect(fetcher).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(delta);
  });

  it("parses Problem Details when explicit connection options are rejected", async () => {
    const { executeCli } = await import("../../src/interfaces/cli/main.js");
    const harness = await startTestApp();
    const output: string[] = [];
    try {
      await expect(executeCli([
        "agents",
        "list",
        "--api-url",
        "http://127.0.0.1:8787",
        "--token",
        "wrong-token",
      ], {
        environment: {},
        fetcher: injectFetcher(harness.app),
        write: (line) => output.push(line),
        writeError: (line) => output.push(line),
      })).resolves.toBe(3);
      expect(output).toHaveLength(2);
      expect(output[0]).toBe("deprecated_command: This command is deprecated; use the TUI or /v1 HTTP Automation Surface.");
      expect(output[1]).toMatch(/^unauthorized: Authentication is required\. \(traceId: .+\)$/u);
    } finally {
      await harness.close();
    }
  });
});

function hasCode(error: unknown, code: string): boolean {
  return typeof error === "object"
    && error !== null
    && "code" in error
    && error.code === code;
}

function injectFetcher(app: FastifyInstance, beforeRequest?: (url: URL) => void): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    beforeRequest?.(url);
    const headers = Object.fromEntries(new Headers(init?.headers).entries());
    const injected = await app.inject({
      method: (init?.method ?? "GET") as never,
      url: `${url.pathname}${url.search}`,
      headers,
      ...(typeof init?.body === "string" ? { payload: init.body } : {}),
    });
    const responseHeaders = new Headers();
    for (const [name, value] of Object.entries(injected.headers)) {
      if (value !== undefined) responseHeaders.set(name, Array.isArray(value) ? value.join(", ") : String(value));
    }
    return new Response(injected.statusCode === 204 ? null : injected.payload, {
      status: injected.statusCode,
      headers: responseHeaders,
    });
  }) as typeof fetch;
}

async function createRun(app: FastifyInstance, sessionKey: string, idempotencyKey: string): Promise<string> {
  const response = await app.inject({
    method: "POST",
    url: "/v1/runs",
    headers: { authorization: "Bearer test-token", "idempotency-key": idempotencyKey },
    payload: { agentId: "primary", sessionKey, input: { type: "text", text: "seed" } },
  });
  expect(response.statusCode).toBe(202);
  return (response.json() as { runId: string }).runId;
}

function seedPendingApproval(db: DatabaseSync, runId: string, suffix: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_approval' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES (?, ?, 'waiting_approval', 'run_command', 'side_effect', ?, ?, ?, 'ask', 0, '{}', ?, ?)`).run(
    `tool-cli-approval-${suffix}`,
    runId,
    '{"args":["hello"],"program":"node"}',
    '{"args":["hello"],"program":"node"}',
    `hash-cli-approval-${suffix}`,
    now,
    now,
  );
  db.prepare(`INSERT INTO approvals (
    approval_id, run_id, tool_call_id, state, arguments_sha256, expires_at, created_at
  ) VALUES (?, ?, ?, 'pending', ?, ?, ?)`).run(
    `approval-cli-${suffix}`,
    runId,
    `tool-cli-approval-${suffix}`,
    `hash-cli-approval-${suffix}`,
    "2026-08-08T00:00:00.000Z",
    now,
  );
}

function seedUnknownToolCall(db: DatabaseSync, runId: string, suffix: string): void {
  const now = "2026-08-07T00:00:00.000Z";
  db.prepare("UPDATE runs SET state = 'waiting_reconciliation' WHERE run_id = ?").run(runId);
  db.prepare(`INSERT INTO tool_calls (
    tool_call_id, run_id, state, tool_name, effect, arguments_json,
    canonical_arguments, arguments_sha256, policy_effect, matched_rule,
    policy_facts_json, created_at, updated_at
  ) VALUES (?, ?, 'unknown', 'write_file', 'side_effect', ?, ?, ?, 'allow', 0, '{}', ?, ?)`).run(
    `tool-cli-${suffix}`,
    runId,
    '{"content":"x","path":"report.txt"}',
    '{"content":"x","path":"report.txt"}',
    `hash-cli-${suffix}`,
    now,
    now,
  );
}
