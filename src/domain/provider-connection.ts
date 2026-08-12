import type { SecretRef } from "../config/secret-ref.js";
import { DomainError } from "./errors.js";
import type {
  ProviderConnectionId,
  ProviderConnectionRevisionId,
} from "./ids.js";
import type {
  InvocationProtocol,
  ProviderKind,
  RegistryRevisionState,
} from "./model-registry.js";
import type { ProviderDriverId } from "./pi-runtime.js";

export type ProviderAuth =
  | { readonly type: "bearer"; readonly secret: Readonly<SecretRef> }
  | { readonly type: "none" };

export interface ProviderConnectionRevision {
  readonly revisionId: ProviderConnectionRevisionId;
  readonly connectionId: ProviderConnectionId;
  readonly state: RegistryRevisionState;
  readonly baseUrl: string;
  readonly auth: ProviderAuth;
  readonly allowInsecureHttp: boolean;
  readonly protocolPreference: InvocationProtocol;
  readonly presetVersion: string;
  readonly createdAt: Date;
}

export interface ProviderConnectionView {
  readonly connectionId: ProviderConnectionId;
  readonly displayName: string;
  readonly providerKind: ProviderKind;
  readonly providerDriver?: ProviderDriverId;
  readonly activeRevisionId: ProviderConnectionRevisionId | null;
  readonly retiredAt: Date | null;
  readonly recordRevision: number;
  readonly revisions: readonly ProviderConnectionRevision[];
}

export function assertConnectionPromotable(
  revision: ProviderConnectionRevision,
): void {
  if (revision.state === "verified") return;
  throw new DomainError("verification_required");
}
