import type { FrozenTurnPrompt, TurnPromptVariableValue } from "@openleek/contracts/turn-prompt";
import { sha256 } from "./canonical";
import { invalidArgument } from "./errors";

const LEGACY_DEFAULT_SOURCE = "Today is {{utcDate}}.";
const LEGACY_DEFAULT_VERSION_REF = "turn-prompt:system-default:v1";
/** Snapshot-decoding fallback only. It is not registered or exposed as a selectable asset. */
export const LEGACY_DEFAULT_TURN_PROMPT: FrozenTurnPrompt = {
  versionRef: LEGACY_DEFAULT_VERSION_REF,
  artifactDigest: sha256({ source: LEGACY_DEFAULT_SOURCE, variables: [] }),
  source: LEGACY_DEFAULT_SOURCE,
  variables: {},
};

const PLACEHOLDER = /\{\{([A-Za-z][A-Za-z0-9_]{0,63})\}\}/g;

/** Render an Experiment-frozen input projection without resolving any asset. */
export function renderTurnPrompt(prompt: FrozenTurnPrompt, input: { utcDate: string; roundId: number }): string {
  const values: Record<string, TurnPromptVariableValue> = { ...prompt.variables, utcDate: input.utcDate, roundId: input.roundId };
  const rendered = prompt.source.replace(PLACEHOLDER, (_, name: string) => values[name] === undefined ? "" : renderValue(values[name]));
  if (!rendered.trim()) invalidArgument("rendered Turn Prompt must not be empty");
  if (rendered.length > 100_000) invalidArgument("rendered Turn Prompt is too long");
  return rendered;
}

function renderValue(value: TurnPromptVariableValue): string {
  if (typeof value === "string") return value;
  if (typeof value === "boolean") return value ? "true" : "false";
  return String(value);
}
