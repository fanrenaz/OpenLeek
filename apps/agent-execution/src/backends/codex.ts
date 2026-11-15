import { sha256 } from "../canonical";
import type { AgentExecutionBackend, BackendExecutionInput, BackendExecutionOutput } from "../ports";
import type { AgentIdentity, AgentMemoryBinding, AgentTurnTokenUsage, ContextCompactionPolicy, ContextMcpConnection, SandboxDescriptor, ToolCallBudget } from "../types";
import { createAgentSessionTranscript } from "../transcript";

/** Narrow Codex port. It has no observation or candidate-action channel. */
export interface CodexTurnClient {
  health?(): Promise<void>;
  startSession(input: { readonly runId: string; readonly sandbox: SandboxDescriptor; readonly agentId: string; readonly model: string; readonly modelProvider: string; readonly sandboxWorkspacePath: string; readonly mcpConnections: readonly ContextMcpConnection[]; readonly baseInstructions: string; readonly developerInstructions: string; readonly memory?: AgentMemoryBinding; readonly contextCompactionPolicy?: ContextCompactionPolicy; readonly toolCallBudget?: ToolCallBudget }): Promise<string>;
  resumeSession(input: { readonly runId: string; readonly sandbox: SandboxDescriptor; readonly sessionId: string; readonly agentId: string; readonly model: string; readonly modelProvider: string; readonly sandboxWorkspacePath: string; readonly mcpConnections: readonly ContextMcpConnection[]; readonly baseInstructions: string; readonly developerInstructions: string; readonly memory?: AgentMemoryBinding; readonly contextCompactionPolicy?: ContextCompactionPolicy; readonly toolCallBudget?: ToolCallBudget }): Promise<void>;
  runTurn(input: { readonly sandbox: SandboxDescriptor; readonly sessionId: string; readonly text: string }): Promise<{ readonly evidence?: unknown; readonly turn?: unknown; readonly events?: readonly { readonly method: string; readonly payload: unknown }[]; readonly tokenUsage?: AgentTurnTokenUsage }>;
  forkSession?(input: { readonly sourceSessionId: string; readonly sourceRunId: string; readonly targetRunId: string; readonly agentId: string }): Promise<string | null>;
}

export class CodexAgentBackend implements AgentExecutionBackend {
  readonly name = "codex" as const;
  constructor(private readonly client: CodexTurnClient) {}
  async health(): Promise<void> {
    // A run sandbox is created lazily. Readiness must not depend on one.
    await this.client.health?.();
  }

  async execute(input: BackendExecutionInput): Promise<BackendExecutionOutput> {
    let sessionId = input.sessionId;
    if (sessionId === null) {
      sessionId = await this.client.startSession({
        runId: input.runId,
        sandbox: input.sandbox,
        agentId: input.agent.agentId,
        model: input.model,
        modelProvider: input.modelProvider,
        sandboxWorkspacePath: input.sandboxWorkspacePath,
        mcpConnections: input.mcpConnections,
        baseInstructions: input.baseInstructions,
        developerInstructions: input.developerInstructions,
        ...(input.memory ? { memory: input.memory } : {}),
        ...(input.contextCompactionPolicy ? { contextCompactionPolicy: input.contextCompactionPolicy } : {}),
        ...(input.toolCallBudget ? { toolCallBudget: input.toolCallBudget } : {}),
      });
    } else {
      await this.client.resumeSession({
        runId: input.runId,
        sandbox: input.sandbox,
        sessionId,
        agentId: input.agent.agentId,
        model: input.model,
        modelProvider: input.modelProvider,
        sandboxWorkspacePath: input.sandboxWorkspacePath,
        mcpConnections: input.mcpConnections,
        baseInstructions: input.baseInstructions,
        developerInstructions: input.developerInstructions,
        ...(input.memory ? { memory: input.memory } : {}),
        ...(input.contextCompactionPolicy ? { contextCompactionPolicy: input.contextCompactionPolicy } : {}),
        ...(input.toolCallBudget ? { toolCallBudget: input.toolCallBudget } : {}),
      });
    }
    if (!sessionId.trim()) throw new Error("Codex did not return a session id");
    const response = await this.client.runTurn({ sandbox: input.sandbox, sessionId, text: input.text });
    if (response.turn === undefined) throw new Error("Codex did not return a complete Turn transcript");
    const transcript = createAgentSessionTranscript({ execution: input, sessionId, turn: response.turn, ...(response.events === undefined ? {} : { events: response.events }), ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }) });
    return {
      sessionId,
      transcript,
      ...(response.tokenUsage === undefined ? {} : { tokenUsage: response.tokenUsage }),
      evidence: {
        sessionId,
        text: input.text,
        evidence: response.evidence ?? null,
        tokenUsage: response.tokenUsage ?? null,
        digest: sha256({ sessionId, text: input.text, evidence: response.evidence ?? null, tokenUsage: response.tokenUsage ?? null }),
      },
    };
  }

  /** Child runs use newly materialized workspaces and credentials. */
  async forkRun(input: { readonly sourceRunId: string; readonly targetRunId: string; readonly agents: readonly AgentIdentity[]; readonly sourceSessions: Readonly<Record<string, string | null>> }): Promise<Readonly<Record<string, string | null>>> {
    return Object.fromEntries(input.agents.map((agent) => [agent.agentId, null]));
  }
}
