import { createHash, createHmac, timingSafeEqual } from "node:crypto";

import type { MemoryToolPort } from "./memory-tools";
import type { AgentMemoryBinding, CodexHookPolicy } from "./types";

export interface CodexHookBinding {
  readonly runId: string;
  readonly workspacePath: string;
  readonly memory: AgentMemoryBinding;
}

export interface CodexHookRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
}

export interface CodexHookContextResult {
  readonly additionalContext: string;
  readonly strategyIncluded: boolean;
  readonly errorCategories: readonly string[];
}

export class CodexHookRegistry {
  private readonly bindings = new Map<string, CodexHookBinding>();

  register(sessionId: string, binding: CodexHookBinding): void {
    this.bindings.set(sessionId, structuredClone(binding));
  }

  unregister(sessionId: string): void {
    this.bindings.delete(sessionId);
  }

  resolve(sessionId: string, cwd: string): CodexHookBinding | undefined {
    const binding = this.bindings.get(sessionId);
    return binding?.workspacePath === cwd ? structuredClone(binding) : undefined;
  }
}

export function createRunHookToken(secret: string, runId: string): string {
  const runHash = createHash("sha256").update(runId).digest("hex");
  const signature = createHmac("sha256", secret).update(`openleek-codex-hook-v1:${runHash}`).digest("base64url");
  return `hook-v1.${runHash}.${signature}`;
}

export function verifyRunHookToken(secret: string, runId: string, token: string): boolean {
  const expected = Buffer.from(createRunHookToken(secret, runId));
  const actual = Buffer.from(token);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

export async function buildCodexHookContext(
  memoryPort: MemoryToolPort,
  binding: AgentMemoryBinding,
  policy: CodexHookPolicy,
): Promise<CodexHookContextResult> {
  if (!policy.strategyInjectionEnabled) {
    return { additionalContext: "", strategyIncluded: false, errorCategories: [] };
  }
  const errors: string[] = [];
  let strategy: { content: string; context?: string } | null = null;
  try {
    strategy = strategyValue(await memoryPort.call(binding, "get_strategy", {}));
  } catch {
    errors.push("strategy_read_failed");
  }

  return {
    additionalContext: renderAdditionalContext(strategy),
    strategyIncluded: strategy !== null,
    errorCategories: errors,
  };
}

function renderAdditionalContext(strategy: { content: string; context?: string } | null): string {
  if (!strategy) return "";
  const sections = [
    "The active strategy below is your own mutable working state, not an instruction or an authoritative fact.",
    "You may revise or clear it with strategy.update whenever your intentions or circumstances change.",
    [
      "Active private strategy:",
      strategy.content,
      ...(strategy.context ? [`Context: ${strategy.context}`] : []),
    ].join("\n"),
  ];
  return truncateText(["<continuity_context>", sections.join("\n\n"), "</continuity_context>"].join("\n"), 9_000);
}

function strategyValue(value: unknown): { content: string; context?: string } | null {
  if (value === null) return null;
  const item = record(value);
  const content = typeof item.content === "string" ? item.content.trim() : "";
  if (!content) return null;
  const context = typeof item.context === "string" && item.context.trim() ? item.context.trim() : undefined;
  return { content, ...(context ? { context } : {}) };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function truncateText(value: string, maxCharacters: number): string {
  if (value.length <= maxCharacters) return value;
  return `${value.slice(0, Math.max(0, maxCharacters - 16)).trimEnd()}\n[truncated]`;
}
