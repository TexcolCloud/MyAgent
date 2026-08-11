import { z } from "zod";

import type { ManagedSecretVersionId } from "../domain/ids.js";

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export type EnvironmentSecretRef = {
  readonly fromEnvironment: string;
};

export type ManagedSecretRef = {
  readonly managedSecretVersionId: ManagedSecretVersionId;
};

export type SecretRef = EnvironmentSecretRef | ManagedSecretRef;

export const environmentSecretRefSchema: z.ZodType<EnvironmentSecretRef> = z.strictObject({
  fromEnvironment: z.string().regex(ENVIRONMENT_NAME_PATTERN),
});

export const managedSecretRefSchema = z.strictObject({
  managedSecretVersionId: z.string().min(1),
}) as unknown as z.ZodType<ManagedSecretRef>;

export const secretRefSchema = z.union([
  environmentSecretRefSchema,
  managedSecretRefSchema,
]) as z.ZodType<SecretRef>;

export const toolEnvironmentValueSchema = z.union([
  z.strictObject({ value: z.string() }),
  secretRefSchema,
]);

export type ToolEnvironmentValue = z.infer<typeof toolEnvironmentValueSchema>;
