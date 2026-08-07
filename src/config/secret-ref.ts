import { z } from "zod";

const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

export const secretRefSchema = z.strictObject({
  fromEnvironment: z.string().regex(ENVIRONMENT_NAME_PATTERN),
});

export type SecretRef = z.infer<typeof secretRefSchema>;

export const toolEnvironmentValueSchema = z.union([
  z.strictObject({ value: z.string() }),
  secretRefSchema,
]);

export type ToolEnvironmentValue = z.infer<typeof toolEnvironmentValueSchema>;
