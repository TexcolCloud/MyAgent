import type { SecretRef } from "../config/secret-ref.js";

export interface SecretResolver {
  resolve(reference: SecretRef): string;
}
