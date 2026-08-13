import { constants as fsConstants } from "node:fs";

import type { ManagedSecretVersionId } from "../domain/ids.js";

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

export async function projectStatePermissionsAvailable(
  root: string,
  databasePath: string,
  access: (path: string, mode: number) => Promise<void>,
): Promise<boolean> {
  try {
    await access(root, fsConstants.R_OK | fsConstants.W_OK | fsConstants.X_OK);
    await access(databasePath, fsConstants.R_OK | fsConstants.W_OK);
    return true;
  } catch { return false; }
}

type DiagnosticRegistry = {
  readonly listConnections: () => readonly {
    readonly activeRevisionId: string | null;
    readonly revisions: readonly {
      readonly revisionId: string;
      readonly auth: { readonly type: "none" } | { readonly type: "bearer"; readonly secret: { readonly fromEnvironment: string } | { readonly managedSecretVersionId: string } };
    }[];
  }[];
  readonly listProfiles: () => readonly {
    readonly activeRevisionId: string | null;
    readonly revisions: readonly { readonly revisionId: string; readonly connectionRevisionId: string }[];
  }[];
};

export function activeSecretReferencesResolvable(
  registry: DiagnosticRegistry,
  environment: Readonly<Record<string, string | undefined>>,
  assertManaged: (versionId: ManagedSecretVersionId) => void,
): boolean {
  try {
    const activeProfileConnections = new Set(registry.listProfiles().flatMap((profile) =>
      profile.revisions
        .filter((revision) => revision.revisionId === profile.activeRevisionId)
        .map((revision) => revision.connectionRevisionId)));
    const revisions = registry.listConnections().flatMap((connection) => connection.revisions.filter((revision) =>
      revision.revisionId === connection.activeRevisionId || activeProfileConnections.has(revision.revisionId)));
    for (const revision of revisions) {
      if (revision.auth.type === "none") continue;
      const reference = revision.auth.secret;
      if ("fromEnvironment" in reference) {
        if (!Object.hasOwn(environment, reference.fromEnvironment)) return false;
      } else {
        assertManaged(reference.managedSecretVersionId as ManagedSecretVersionId);
      }
    }
    return true;
  } catch { return false; }
}
