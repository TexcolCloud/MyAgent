export type DiagnosticStatus = "ok" | "failed";

export interface DiagnosticCheck {
  readonly id: "config" | "permissions" | "sqlite" | "secrets" | "workers" | "gateway" | "tty" | "binding";
  readonly status: DiagnosticStatus;
  readonly detail: string;
}

export interface DiagnosticReport {
  readonly checks: readonly DiagnosticCheck[];
}

export interface DiagnosticProbes {
  readonly config: () => boolean | Promise<boolean | void>;
  readonly permissions: () => boolean | Promise<boolean | void>;
  readonly sqlite: () => boolean | Promise<boolean | void>;
  readonly secrets: () => boolean | Promise<boolean | void>;
  readonly workers: () => boolean | Promise<boolean | void>;
  readonly gateway: () => boolean | Promise<boolean | void>;
  readonly tty: () => boolean | Promise<boolean | void>;
  readonly binding: () => boolean | Promise<boolean | void>;
}

const checks = [
  ["config", "config_readable", "config_unreadable"],
  ["permissions", "project_permissions_ok", "project_permissions_unavailable"],
  ["sqlite", "sqlite_migrations_current", "sqlite_migrations_unavailable"],
  ["secrets", "secret_references_resolved", "secret_references_unavailable"],
  ["workers", "worker_ready", "worker_not_ready"],
  ["gateway", "provider_gateway_available", "provider_gateway_unavailable"],
  ["tty", "interactive_tty_available", "interactive_tty_unavailable"],
  ["binding", "loopback_binding", "binding_unavailable"],
] as const satisfies readonly [DiagnosticCheck["id"], string, string][];

export async function collectDiagnostics(probes: DiagnosticProbes): Promise<DiagnosticReport> {
  return { checks: await Promise.all(checks.map(async ([id, ok, failed]) => ({
    id,
    ...(await passes(probes[id]) ? { status: "ok" as const, detail: ok } : { status: "failed" as const, detail: failed }),
  }))) };
}

async function passes(probe: () => boolean | Promise<boolean | void>): Promise<boolean> {
  try { return (await probe()) !== false; } catch { return false; }
}
