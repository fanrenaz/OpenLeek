import { agentSessionTranscriptSchema } from "@openleek/contracts/observability";

import { sha256 } from "./canonical";
import type { BackendExecutionInput } from "./ports";
import type { AgentSessionTranscript, AgentTurnTokenUsage, JsonValue } from "./types";

const redacted = "[REDACTED]";
const secretKey = /^(authorization|proxy-authorization|api[_-]?key|access[_-]?token|auth[_-]?token|bearer[_-]?token|credential|credentials|password|private[_-]?key)$/i;

export function createAgentSessionTranscript(input: {
  readonly execution: BackendExecutionInput;
  readonly sessionId: string;
  readonly turn: unknown;
  readonly events?: readonly { readonly method: string; readonly payload: unknown }[];
  readonly tokenUsage?: AgentTurnTokenUsage;
  readonly now?: () => string;
}): AgentSessionTranscript {
  const turn = record(input.turn);
  const secrets = input.execution.mcpConnections.map((connection) => connection.credential).filter(Boolean);
  const counter = { value: 0 };
  const items = (Array.isArray(turn.items) ? turn.items : []).map((item, sequence) => {
    const value = record(item);
    const type = typeof value.type === "string" && value.type ? value.type : "unknown";
    const payload: Record<string, JsonValue> = {};
    for (const [key, candidate] of Object.entries(value)) {
      if (key === "type" || key === "id") continue;
      // Codex reasoning content is private chain-of-thought. The explicit
      // summary is observable audit material; the raw content is not.
      if (type === "reasoning" && key === "content") continue;
      const normalized = sanitize(candidate, secrets, counter, key);
      if (normalized !== undefined) payload[key] = normalized;
    }
    return {
      sequence,
      type,
      ...(typeof value.id === "string" && value.id ? { id: value.id } : {}),
      payload,
    };
  });
  const status = turn.status === "completed" || turn.status === "failed" || turn.status === "interrupted"
    ? turn.status
    : "interrupted";
  const body = {
    schemaVersion: "1" as const,
    runId: input.execution.runId,
    roundId: input.execution.roundId,
    agentId: input.execution.agent.agentId,
    attemptId: input.execution.attemptId,
    orchestrationTurnId: input.execution.orchestrationTurnId,
    threadId: input.sessionId,
    turnId: requireText(turn.id, "Codex Turn transcript is missing turn.id"),
    session: {
      model: input.execution.model,
      modelProvider: input.execution.modelProvider,
      agentsMdVersionRef: input.execution.agent.agentsMdVersionRef,
      agentsMdDigest: input.execution.agent.agentsMdDigest,
      baseInstructions: sanitizeText(input.execution.baseInstructions, secrets, counter),
      developerInstructions: sanitizeText(input.execution.developerInstructions, secrets, counter),
    },
    prompt: sanitizeText(input.execution.text, secrets, counter),
    status,
    error: sanitize(turn.error ?? null, secrets, counter) ?? null,
    startedAt: timestamp(turn.startedAt),
    completedAt: timestamp(turn.completedAt),
    durationMs: typeof turn.durationMs === "number" && Number.isFinite(turn.durationMs) && turn.durationMs >= 0
      ? Math.trunc(turn.durationMs)
      : null,
    items,
    ...(input.events === undefined ? {} : {
      events: input.events.map((event, sequence) => ({
        sequence,
        method: event.method,
        payload: sanitize(event.payload, secrets, counter) ?? null,
      })),
    }),
    ...(input.tokenUsage === undefined ? {} : { tokenUsage: structuredClone(input.tokenUsage) }),
    redactionCount: counter.value,
  };
  const digest = sha256(body);
  return agentSessionTranscriptSchema.parse({
    ...body,
    transcriptRef: `transcript:${digest}`,
    digest,
    recordedAt: (input.now ?? (() => new Date().toISOString()))(),
  });
}

function sanitize(value: unknown, secrets: readonly string[], counter: { value: number }, key?: string): JsonValue | undefined {
  if (key && secretKey.test(key)) {
    counter.value += 1;
    return redacted;
  }
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return sanitizeText(value, secrets, counter);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (Array.isArray(value)) return value.flatMap((item) => {
    const normalized = sanitize(item, secrets, counter);
    return normalized === undefined ? [] : [normalized];
  });
  if (value && typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    const record = value as Record<string, unknown>;
    for (const [childKey, child] of Object.entries(record)) {
      // The event stream can contain raw reasoning items in addition to the
      // projected Turn items. Preserve their summaries, never private content.
      if (record.type === "reasoning" && childKey === "content") continue;
      const normalized = sanitize(child, secrets, counter, childKey);
      if (normalized !== undefined) result[childKey] = normalized;
    }
    return result;
  }
  return undefined;
}

function sanitizeText(value: string, secrets: readonly string[], counter: { value: number }): string {
  let result = value.replace(/Bearer\s+[A-Za-z0-9._~+\/-]{16,}/gi, () => {
    counter.value += 1;
    return `Bearer ${redacted}`;
  });
  for (const secret of secrets) {
    if (!secret || !result.includes(secret)) continue;
    const occurrences = result.split(secret).length - 1;
    counter.value += occurrences;
    result = result.split(secret).join(redacted);
  }
  return result;
}

function timestamp(value: unknown): string | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return new Date(value * 1_000).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function requireText(value: unknown, message: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(message);
  return value;
}
