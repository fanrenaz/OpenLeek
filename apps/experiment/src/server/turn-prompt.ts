import { TURN_PROMPT_SYSTEM_VARIABLES, turnPromptPlaceholderNames, turnPromptVariableDefinitionSchema, turnPromptVariableValueSchema, type FrozenTurnPrompt, type TurnPromptSelection, type TurnPromptVariableDefinition, type TurnPromptVariableValue } from "@openleek/contracts/turn-prompt";
import { sha256Digest } from "@openleek/contracts/canonical";
import { OpenLeekDomainError } from "@openleek/trpc";
import type { TurnPromptVersion } from "./model";

const BUILT_INS = new Set<string>(TURN_PROMPT_SYSTEM_VARIABLES.map(({ name }) => name));
const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;

export function validateTurnPromptDefinition(source: string, rawDefinitions: readonly TurnPromptVariableDefinition[]): TurnPromptVariableDefinition[] {
  if (!source.trim()) invalid("Turn Prompt source must not be empty", "source", "must not be empty");
  if (source.length > 100_000) invalid("Turn Prompt source is too long", "source", "must be at most 100000 characters");
  if (rawDefinitions.length > 100) invalid("Turn Prompt declares too many variables", "variables", "must contain at most 100 variables");
  const definitions = rawDefinitions.map((value, index) => {
    const definition = turnPromptVariableDefinitionSchema.parse(value);
    if (BUILT_INS.has(definition.name)) invalid(`Turn Prompt variable '${definition.name}' is reserved`, `variables[${index}].name`, "is a system variable");
    if (definition.defaultValue !== undefined && !matchesType(definition.defaultValue, definition.type)) invalid(`Turn Prompt variable '${definition.name}' has a default value of the wrong type`, `variables[${index}].defaultValue`, `must be ${definition.type}`);
    return definition;
  });
  if (new Set(definitions.map(({ name }) => name)).size !== definitions.length) invalid("Turn Prompt variable names must be unique", "variables", "contains duplicate names");
  const malformed = source.replace(PLACEHOLDER, "");
  if (malformed.includes("{{") || malformed.includes("}}")) invalid("Turn Prompt contains malformed placeholder syntax", "source", "use {{variableName}}");
  const placeholders = new Set(turnPromptPlaceholderNames(source));
  const declared = new Set(definitions.map(({ name }) => name));
  for (const placeholder of placeholders) if (!BUILT_INS.has(placeholder) && !declared.has(placeholder)) invalid(`Turn Prompt uses undeclared variable '${placeholder}'`, "source", "contains an undeclared variable");
  for (const definition of definitions) if (!placeholders.has(definition.name)) invalid(`Turn Prompt variable '${definition.name}' is not used`, "variables", "contains an unused declaration");
  return definitions;
}

export function resolveTurnPrompt(version: TurnPromptVersion, selection: TurnPromptSelection): FrozenTurnPrompt {
  if (selection.versionRef !== version.versionRef) invalid("Turn Prompt selection does not match the published version", "turnPrompt.versionRef", "does not match the asset");
  const definitions = validateTurnPromptDefinition(version.source, version.variables);
  const declared = new Map(definitions.map((definition) => [definition.name, definition]));
  for (const name of Object.keys(selection.variables)) if (!declared.has(name)) invalid(`Turn Prompt value '${name}' is not declared`, `turnPrompt.variables.${name}`, "is not declared by this asset");
  const variables: Record<string, TurnPromptVariableValue> = {};
  for (const definition of definitions) {
    const value = selection.variables[definition.name] ?? definition.defaultValue;
    if (value === undefined) {
      if (definition.required) invalid(`Turn Prompt variable '${definition.name}' is required`, `turnPrompt.variables.${definition.name}`, "is required");
      continue;
    }
    turnPromptVariableValueSchema.parse(value);
    if (!matchesType(value, definition.type)) invalid(`Turn Prompt variable '${definition.name}' has the wrong type`, `turnPrompt.variables.${definition.name}`, `must be ${definition.type}`);
    variables[definition.name] = value;
  }
  return { versionRef: version.versionRef, artifactDigest: version.artifactDigest, source: version.source, variables };
}

export function renderTurnPrompt(prompt: FrozenTurnPrompt, input: { utcDate: string; roundId: number }): string {
  const values: Record<string, TurnPromptVariableValue> = { ...prompt.variables, utcDate: input.utcDate, roundId: input.roundId };
  const rendered = prompt.source.replace(PLACEHOLDER, (_, name: string) => values[name] === undefined ? "" : renderValue(values[name]));
  if (!rendered.trim()) invalid("rendered Turn Prompt must not be empty", "turnPrompt", "renders to an empty value");
  if (rendered.length > 100_000) invalid("rendered Turn Prompt is too long", "turnPrompt", "must be at most 100000 characters");
  return rendered;
}

function matchesType(value: TurnPromptVariableValue, type: TurnPromptVariableDefinition["type"]): boolean {
  return typeof value === type && (type !== "number" || Number.isFinite(value));
}

function renderValue(value: TurnPromptVariableValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}

function invalid(message: string, field: string, violation: string): never {
  throw new OpenLeekDomainError({ code: "INVALID_ARGUMENT", message, violations: [{ field, message: violation }] });
}
