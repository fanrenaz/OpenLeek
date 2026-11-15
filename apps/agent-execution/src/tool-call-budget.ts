import type { ToolCallBudget, ToolCallBudgetEvidence } from "./types";

export interface ToolCallBudgetBinding {
  readonly runId: string;
  readonly agentId: string;
  readonly workspacePath: string;
  readonly policy?: ToolCallBudget;
}

export interface ToolCallBudgetRequest {
  readonly sessionId: string;
  readonly turnId: string;
  readonly cwd: string;
  readonly toolName: string;
  readonly toolUseId: string;
}

export interface ToolCallBudgetDecision {
  readonly allowed: boolean;
  readonly toolName: string;
  readonly calls: number;
  readonly limit: number;
  readonly exhausted: boolean;
}

interface Decision extends ToolCallBudgetDecision {}
interface TurnState {
  readonly counts: Map<string, number>;
  readonly decisions: Map<string, Decision>;
  termination?: NonNullable<ToolCallBudgetEvidence["termination"]>;
  interrupt?: () => Promise<void>;
  interruptRequested: boolean;
}

/** Process-local authority for active Codex turns. Durable evidence is returned on finish. */
export class ToolCallBudgetRegistry {
  private readonly bindings = new Map<string, ToolCallBudgetBinding>();
  private readonly turns = new Map<string, TurnState>();

  registerSession(sessionId: string, binding: ToolCallBudgetBinding): void {
    this.bindings.set(sessionId, structuredClone(binding));
  }

  unregisterSession(sessionId: string): void {
    this.bindings.delete(sessionId);
    for (const key of this.turns.keys()) if (key.startsWith(`${sessionId}\u0000`)) this.turns.delete(key);
  }

  resolve(sessionId: string, cwd: string): ToolCallBudgetBinding | undefined {
    const binding = this.bindings.get(sessionId);
    return binding?.workspacePath === cwd ? structuredClone(binding) : undefined;
  }

  beginTurn(sessionId: string, turnId: string, interrupt: () => Promise<void>): void {
    const state = this.turn(sessionId, turnId);
    state.interrupt = interrupt;
    this.maybeInterrupt(state);
  }

  authorize(input: ToolCallBudgetRequest): ToolCallBudgetDecision {
    const binding = this.resolve(input.sessionId, input.cwd);
    if (!binding?.policy) throw new Error("tool_call_budget_unavailable");
    const state = this.turn(input.sessionId, input.turnId);
    const existing = state.decisions.get(input.toolUseId);
    if (existing) return { ...existing };
    const toolName = normalizeToolName(input.toolName);
    const calls = (state.counts.get(toolName) ?? 0) + 1;
    state.counts.set(toolName, calls);
    const limit = binding.policy.maxCallsPerToolPerTurn;
    const decision: Decision = { allowed: calls <= limit, toolName, calls, limit, exhausted: calls > limit };
    state.decisions.set(input.toolUseId, decision);
    if (!decision.allowed && state.termination === undefined) {
      state.termination = {
        reason: "tool_repeat_budget_exhausted",
        toolName,
        limit,
        attemptedCall: calls,
        toolUseId: input.toolUseId,
        occurredAt: new Date().toISOString(),
      };
      this.maybeInterrupt(state);
    }
    return { ...decision };
  }

  observe(input: ToolCallBudgetRequest): ToolCallBudgetDecision | undefined {
    const binding = this.resolve(input.sessionId, input.cwd);
    if (!binding?.policy) return undefined;
    return this.authorize(input);
  }

  exhausted(sessionId: string, turnId: string): boolean {
    return this.turns.get(turnKey(sessionId, turnId))?.termination !== undefined;
  }

  finishTurn(sessionId: string, turnId: string): ToolCallBudgetEvidence | undefined {
    const binding = this.bindings.get(sessionId);
    if (!binding?.policy) return undefined;
    const key = turnKey(sessionId, turnId);
    const state = this.turns.get(key) ?? this.newTurn();
    this.turns.delete(key);
    return {
      maxCallsPerToolPerTurn: binding.policy.maxCallsPerToolPerTurn,
      counts: [...state.counts.entries()].map(([toolName, calls]) => ({ toolName, calls })).sort((a, b) => a.toolName.localeCompare(b.toolName)),
      ...(state.termination ? { termination: structuredClone(state.termination) } : {}),
    };
  }

  private turn(sessionId: string, turnId: string): TurnState {
    const key = turnKey(sessionId, turnId);
    let state = this.turns.get(key);
    if (!state) { state = this.newTurn(); this.turns.set(key, state); }
    return state;
  }

  private newTurn(): TurnState {
    return { counts: new Map(), decisions: new Map(), interruptRequested: false };
  }

  private maybeInterrupt(state: TurnState): void {
    if (!state.termination || !state.interrupt || state.interruptRequested) return;
    state.interruptRequested = true;
    void state.interrupt().catch(() => undefined);
  }
}

export function normalizeToolName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) throw new Error("tool name must not be empty");
  const aliases: Record<string, string> = { Bash: "exec_command", Edit: "apply_patch", Write: "apply_patch", ApplyPatch: "apply_patch" };
  const aliased = aliases[trimmed] ?? trimmed;
  const mcp = /^mcp__([a-zA-Z0-9_-]+)__([a-zA-Z0-9_-]+)$/.exec(aliased);
  return mcp ? `${mcp[1]}.${mcp[2]}` : aliased;
}

function turnKey(sessionId: string, turnId: string): string { return `${sessionId}\u0000${turnId}`; }
