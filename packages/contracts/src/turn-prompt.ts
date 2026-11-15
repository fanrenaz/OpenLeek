import { z } from "zod";
import { digestSchema, identifierSchema } from "./core";

export const turnPromptVariableTypeSchema = z.enum(["string", "number", "boolean"]);
export type TurnPromptVariableType = z.infer<typeof turnPromptVariableTypeSchema>;
export const turnPromptVariableValueSchema = z.union([
  z.string().max(10_000),
  z.number().finite(),
  z.boolean(),
]);
export type TurnPromptVariableValue = z.infer<typeof turnPromptVariableValueSchema>;
export const turnPromptVariableDefinitionSchema = z.object({
  name: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/),
  type: turnPromptVariableTypeSchema,
  required: z.boolean().default(false),
  defaultValue: turnPromptVariableValueSchema.optional(),
  description: z.string().max(1_000).optional(),
}).strict();
export type TurnPromptVariableDefinition = z.infer<typeof turnPromptVariableDefinitionSchema>;
export const TURN_PROMPT_SYSTEM_VARIABLES = [
  { name: "utcDate", type: "string" },
  { name: "roundId", type: "number" },
] as const satisfies ReadonlyArray<{ name: string; type: TurnPromptVariableType }>;
export type TurnPromptSystemVariableName = (typeof TURN_PROMPT_SYSTEM_VARIABLES)[number]["name"];

/** Return valid placeholder names once, in source order. */
export function turnPromptPlaceholderNames(source: string): string[] {
  return [...new Set(
    [...source.matchAll(/\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g)]
      .map((match) => match[1]!),
  )];
}
export const turnPromptSelectionSchema = z.object({
  versionRef: identifierSchema,
  variables: z.record(z.string(), turnPromptVariableValueSchema).default({}),
}).strict();
export type TurnPromptSelection = z.infer<typeof turnPromptSelectionSchema>;
export const frozenTurnPromptSchema = z.object({
  versionRef: identifierSchema,
  artifactDigest: digestSchema,
  source: z.string().min(1).max(100_000),
  variables: z.record(z.string(), turnPromptVariableValueSchema),
}).strict();
export type FrozenTurnPrompt = z.infer<typeof frozenTurnPromptSchema>;
