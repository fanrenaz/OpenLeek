import { WebSocket } from "ws";

import type {
  ActionTokenAttribution,
  AgentMemoryBinding,
  AgentTurnTokenUsage,
  ContextCompactionPolicy,
  ContextMcpConnection,
  ToolCallBudget,
  TokenAttributedToolCall,
  TokenUsageBreakdown,
} from "../types";
import type { SandboxDescriptor } from "../types";
import type { CodexTurnClient } from "./codex";
import { dynamicToolsForMemoryProfile, resolveMemoryDynamicTool, type MemoryToolPort } from "../memory-tools";
import { CodexHookRegistry } from "../codex-hook";
import { ToolCallBudgetRegistry } from "../tool-call-budget";
import type { ChatGptAuthClient } from "../chatgpt-auth";

type JsonRpcId = string | number;

interface JsonRpcResponse { readonly id: JsonRpcId; readonly result?: unknown; readonly error?: { readonly code: number; readonly message: string }; }
interface JsonRpcServerRequest { readonly id: JsonRpcId; readonly method: string; readonly params?: unknown; }
interface ConnectionState {
  socket: WebSocket | undefined;
  connection: Promise<void> | undefined;
  nextRequestId: number;
  readonly pending: Map<number, PendingRequest>;
  readonly activeSessions: Set<string>;
  readonly memoryBindings: Map<string, AgentMemoryBinding>;
  readonly sessionPaths: Map<string, string>;
  readonly tokenCollector: TurnTokenCollector;
  chatGptAccountId?: string;
}
interface PendingRequest { readonly resolve: (result: unknown) => void; readonly reject: (error: Error) => void; readonly timeout: ReturnType<typeof setTimeout>; }

export interface CodexAppServerTurnClientOptions {
  readonly token?: string;
  readonly sandboxMode: "workspace-write" | "danger-full-access";
  readonly turnTimeoutMs?: number;
  readonly memoryPort?: MemoryToolPort;
  readonly hookRegistry?: CodexHookRegistry;
  readonly toolCallBudgetRegistry?: ToolCallBudgetRegistry;
  readonly chatGptAuth?: ChatGptAuthClient;
}

/**
 * WebSocket connections are selected from the persisted run sandbox descriptor.
 * There is intentionally no default URL or global app-server health probe.
 * A descriptor generation change creates a new connection, forcing persisted
 * thread IDs through `thread/resume` after a sandbox restart.
 */
export class CodexAppServerTurnClient implements CodexTurnClient {
  private readonly connections = new Map<string, ConnectionState>();
  private readonly turnTimeoutMs: number;

  constructor(private readonly options: CodexAppServerTurnClientOptions) {
    this.turnTimeoutMs = options.turnTimeoutMs ?? 30 * 60_000;
  }

  async health(): Promise<void> {
    // Readiness must not create or require any run sandbox.
  }

  async startSession(input: { readonly runId: string; readonly sandbox: SandboxDescriptor; readonly agentId: string; readonly model: string; readonly modelProvider: string; readonly sandboxWorkspacePath: string; readonly mcpConnections: readonly ContextMcpConnection[]; readonly baseInstructions: string; readonly developerInstructions: string; readonly memory?: AgentMemoryBinding; readonly contextCompactionPolicy?: ContextCompactionPolicy; readonly toolCallBudget?: ToolCallBudget }): Promise<string> {
    await this.ensureProviderAuthorization(input.sandbox, input.modelProvider);
    const response = await this.request(input.sandbox, "thread/start", {
      model: input.model,
      modelProvider: input.modelProvider,
      cwd: input.sandboxWorkspacePath,
      sandbox: this.options.sandboxMode,
      approvalPolicy: "never",
      experimentalRawEvents: true,
      ...(input.memory ? { dynamicTools: dynamicToolsForMemoryProfile(input.memory.toolProfile) } : {}),
      ...codexThreadInstructionParams(input),
      config: { ...codexThreadInstructionParams(input).config, ...codexMcpConfig(input.mcpConnections) },
    }) as { thread?: { id?: unknown } };
    const threadId = response.thread?.id;
    if (typeof threadId !== "string" || !threadId.trim()) throw new Error("Codex app-server did not return a thread id");
    await this.assertMcpReady(input.sandbox, threadId, input.mcpConnections);
    this.connectionFor(input.sandbox).activeSessions.add(threadId);
    this.connectionFor(input.sandbox).sessionPaths.set(threadId, input.sandboxWorkspacePath);
    if (input.memory) this.connectionFor(input.sandbox).memoryBindings.set(threadId, input.memory);
    if (input.memory) this.options.hookRegistry?.register(threadId, {
      runId: input.runId,
      workspacePath: input.sandboxWorkspacePath,
      memory: input.memory,
    });
    this.options.toolCallBudgetRegistry?.registerSession(threadId, { runId: input.runId, agentId: input.agentId, workspacePath: input.sandboxWorkspacePath, ...(input.toolCallBudget ? { policy: input.toolCallBudget } : {}) });
    return threadId;
  }

  async resumeSession(input: { readonly runId: string; readonly sandbox: SandboxDescriptor; readonly sessionId: string; readonly agentId: string; readonly model: string; readonly modelProvider: string; readonly sandboxWorkspacePath: string; readonly mcpConnections: readonly ContextMcpConnection[]; readonly baseInstructions: string; readonly developerInstructions: string; readonly memory?: AgentMemoryBinding; readonly contextCompactionPolicy?: ContextCompactionPolicy; readonly toolCallBudget?: ToolCallBudget }): Promise<void> {
    await this.ensureProviderAuthorization(input.sandbox, input.modelProvider);
    const state = this.connectionFor(input.sandbox);
    if (state.activeSessions.has(input.sessionId)) {
      if (input.memory) state.memoryBindings.set(input.sessionId, input.memory);
      state.sessionPaths.set(input.sessionId, input.sandboxWorkspacePath);
      this.options.toolCallBudgetRegistry?.registerSession(input.sessionId, { runId: input.runId, agentId: input.agentId, workspacePath: input.sandboxWorkspacePath, ...(input.toolCallBudget ? { policy: input.toolCallBudget } : {}) });
      if (input.memory) this.options.hookRegistry?.register(input.sessionId, {
        runId: input.runId,
        workspacePath: input.sandboxWorkspacePath,
        memory: input.memory,
      });
      return;
    }
    await this.request(input.sandbox, "thread/resume", {
      threadId: input.sessionId,
      model: input.model,
      modelProvider: input.modelProvider,
      cwd: input.sandboxWorkspacePath,
      sandbox: this.options.sandboxMode,
      approvalPolicy: "never",
      ...(input.memory ? { dynamicTools: dynamicToolsForMemoryProfile(input.memory.toolProfile) } : {}),
      ...codexThreadInstructionParams(input),
      config: { ...codexThreadInstructionParams(input).config, ...codexMcpConfig(input.mcpConnections) },
    });
    await this.assertMcpReady(input.sandbox, input.sessionId, input.mcpConnections);
    state.activeSessions.add(input.sessionId);
    state.sessionPaths.set(input.sessionId, input.sandboxWorkspacePath);
    if (input.memory) state.memoryBindings.set(input.sessionId, input.memory);
    if (input.memory) this.options.hookRegistry?.register(input.sessionId, {
      runId: input.runId,
      workspacePath: input.sandboxWorkspacePath,
      memory: input.memory,
    });
    this.options.toolCallBudgetRegistry?.registerSession(input.sessionId, { runId: input.runId, agentId: input.agentId, workspacePath: input.sandboxWorkspacePath, ...(input.toolCallBudget ? { policy: input.toolCallBudget } : {}) });
  }

  async runTurn(input: { readonly sandbox: SandboxDescriptor; readonly sessionId: string; readonly text: string }): Promise<{ readonly evidence?: unknown; readonly turn?: unknown; readonly events?: readonly ProtocolEvent[]; readonly tokenUsage?: AgentTurnTokenUsage }> {
    if (!input.text.trim() || input.text.length > 100_000) throw new Error("Codex turn text must be non-empty and at most 100000 characters");
    const response = await this.request(input.sandbox, "turn/start", {
      threadId: input.sessionId,
      input: [{ type: "text", text: input.text, text_elements: [] }],
      approvalPolicy: "never",
    }) as { turn?: { id?: unknown } };
    const turnId = response.turn?.id;
    if (typeof turnId !== "string" || !turnId.trim()) throw new Error("Codex app-server did not return a turn id");
    const collector = this.connectionFor(input.sandbox).tokenCollector;
    collector.begin(input.sessionId, turnId);
    this.options.toolCallBudgetRegistry?.beginTurn(input.sessionId, turnId, async () => {
      await this.request(input.sandbox, "turn/interrupt", { threadId: input.sessionId, turnId });
    });
    const turn = await this.waitForTurn(input.sandbox, input.sessionId, turnId);
    await this.quiesceThread(input.sandbox, input.sessionId, turnId);
    if (turn.itemsView !== "full") throw new Error("Codex app-server did not return the full Turn item history");
    const capture = collector.finishCapture(input.sessionId, turnId);
    const toolCallBudget = this.options.toolCallBudgetRegistry?.finishTurn(input.sessionId, turnId);
    return {
      evidence: { turnId, text: turnText(turn) },
      turn: structuredClone(turn),
      events: capture.events,
      tokenUsage: { ...capture.tokenUsage, ...(toolCallBudget ? { toolCallBudget } : {}) },
    };
  }

  private connectionFor(sandbox: SandboxDescriptor): ConnectionState {
    const key = connectionKey(sandbox);
    let state = this.connections.get(key);
    if (!state) {
      state = {
        socket: undefined,
        connection: undefined,
        nextRequestId: 1,
        pending: new Map(),
        activeSessions: new Set(),
        memoryBindings: new Map(),
        sessionPaths: new Map(),
        tokenCollector: new TurnTokenCollector(),
      };
      this.connections.set(key, state);
    }
    return state;
  }

  private async connected(sandbox: SandboxDescriptor): Promise<void> {
    const state = this.connectionFor(sandbox);
    if (state.socket?.readyState === WebSocket.OPEN) return;
    state.connection ??= this.connect(sandbox, state);
    try { await state.connection; } finally { state.connection = undefined; }
  }

  private async connect(sandbox: SandboxDescriptor, state: ConnectionState): Promise<void> {
    if (sandbox.lifecycle !== "running") throw new Error(`Codex sandbox for run '${sandbox.runId}' is not running`);
    const socket = new WebSocket(sandbox.endpoint, {
      headers: this.options.token ? { Authorization: `Bearer ${this.options.token}` } : undefined,
      handshakeTimeout: 30_000,
    });
    state.socket = socket;
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error("Codex app-server WebSocket connection timed out")), 30_000);
      socket.once("open", () => { clearTimeout(timeout); resolve(); });
      socket.once("error", (error) => { clearTimeout(timeout); reject(error); });
      socket.on("message", (message) => this.onMessage(state, message.toString()));
      socket.on("close", (code, reason) => this.onClose(state, socket, code, reason.toString()));
    });
    await this.requestOpen(state, "initialize", {
      clientInfo: { name: "openleek-agent-execution", title: "OpenLeek Agent Execution", version: "2.2.0" },
      capabilities: { experimentalApi: true, requestAttestation: false },
    });
    socket.send(JSON.stringify({ method: "initialized", params: {} }));
  }

  private async request(sandbox: SandboxDescriptor, method: string, params: Record<string, unknown>): Promise<unknown> {
    await this.connected(sandbox);
    return this.requestOpen(this.connectionFor(sandbox), method, params);
  }

  private requestOpen(state: ConnectionState, method: string, params: Record<string, unknown>): Promise<unknown> {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) throw new Error("Codex app-server is not connected");
    const id = state.nextRequestId++;
    const result = new Promise<unknown>((resolve, reject) => {
      const timeout = setTimeout(() => {
        state.pending.delete(id);
        reject(new Error(`Codex app-server request timed out: ${method}`));
      }, this.turnTimeoutMs);
      state.pending.set(id, { resolve, reject, timeout });
    });
    socket.send(JSON.stringify({ jsonrpc: "2.0", id, method, params }));
    return result;
  }

  private onMessage(state: ConnectionState, raw: string): void {
    let parsed: unknown;
    try { parsed = JSON.parse(raw) as JsonRpcResponse; } catch { return; }
    if (isServerRequest(parsed)) {
      void this.respondToServerRequest(state, parsed);
      return;
    }
    if (isNotification(parsed)) {
      state.tokenCollector.accept(parsed.method, parsed.params);
      this.observeToolCalls(state, parsed.method, parsed.params);
      return;
    }
    if (!isResponse(parsed) || typeof parsed.id !== "number" || !Number.isInteger(parsed.id)) return;
    const pending = state.pending.get(parsed.id);
    if (!pending) return;
    state.pending.delete(parsed.id);
    clearTimeout(pending.timeout);
    if (parsed.error) pending.reject(new Error(`Codex app-server error ${parsed.error.code}: ${parsed.error.message}`));
    else pending.resolve(parsed.result);
  }

  private observeToolCalls(state: ConnectionState, method: string, params: unknown): void {
    if (method !== "rawResponseItem/completed" || !isRecord(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string" || !isRecord(params.item)) return;
    const cwd = state.sessionPaths.get(params.threadId);
    if (!cwd) return;
    for (const call of rawToolCall(params.item)) {
      const name = call.namespace ? `${call.namespace}.${call.name}` : call.name;
      this.options.toolCallBudgetRegistry?.observe({ sessionId: params.threadId, turnId: params.turnId, cwd, toolName: name, toolUseId: call.callId });
    }
  }

  /**
   * App-server approval callbacks are JSON-RPC requests in the opposite
   * direction.  `approvalPolicy: never` suppresses ordinary prompts but does
   * not grant a new permission profile, so ignoring these requests leaves an
   * otherwise healthy MCP turn permanently in `waitingOnApproval`.
   *
   * The execution service is the approval boundary for these sandboxes. It
   * grants only the requested network bit for the current turn, which is what
   * static Context MCP calls need on the private sandbox mesh. It never grants
   * additional filesystem roots and declines shell/file-change approvals.
   */
  private async respondToServerRequest(state: ConnectionState, request: JsonRpcServerRequest): Promise<void> {
    const socket = state.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    let result: Record<string, unknown> | undefined;
    let secretExchange = false;
    if (request.method === "account/chatgptAuthTokens/refresh") {
      try {
        if (!this.options.chatGptAuth) throw new Error("ChatGPT authorization broker is unavailable");
        const tokens = await this.options.chatGptAuth.tokens(true);
        result = { accessToken: tokens.accessToken, chatgptAccountId: tokens.accountId, ...(tokens.plan ? { chatgptPlanType: tokens.plan } : {}) };
        state.chatGptAccountId = tokens.accountId;
        secretExchange = true;
      } catch (error) {
        try { socket.send(JSON.stringify({ jsonrpc: "2.0", id: request.id, error: { code: -32001, message: error instanceof Error ? error.message : String(error) } })); } catch { /* connection closed */ }
        return;
      }
    } else if (request.method === "item/tool/call") {
      result = await this.memoryToolResult(state, request).catch((error) => ({
        contentItems: [{ type: "inputText", text: error instanceof Error ? error.message : String(error) }],
        success: false,
      }));
    } else {
      result = serverRequestResult(request);
    }
    const response = result === undefined
      ? { jsonrpc: "2.0", id: request.id, error: { code: -32601, message: `Unsupported Codex app-server request: ${request.method}` } }
      : { jsonrpc: "2.0", id: request.id, result };
    if (!secretExchange) state.tokenCollector.acceptServerExchange(request.method, request.params, result ?? response);
    try { socket.send(JSON.stringify(response)); } catch { /* The close handler rejects pending calls. */ }
  }

  private async ensureProviderAuthorization(sandbox: SandboxDescriptor, provider: string): Promise<void> {
    if (provider !== "openai") return;
    if (!this.options.chatGptAuth) throw new Error("ChatGPT authorization broker is unavailable");
    const state = this.connectionFor(sandbox);
    const tokens = await this.options.chatGptAuth.tokens(false);
    if (state.chatGptAccountId === tokens.accountId) return;
    await this.request(sandbox, "account/login/start", { type: "chatgptAuthTokens", accessToken: tokens.accessToken, chatgptAccountId: tokens.accountId, ...(tokens.plan ? { chatgptPlanType: tokens.plan } : {}) });
    state.chatGptAccountId = tokens.accountId;
  }

  private async assertMcpReady(sandbox: SandboxDescriptor, threadId: string, connections: readonly ContextMcpConnection[]): Promise<void> {
    if (connections.length === 0) return;
    const value = await this.request(sandbox, "mcpServerStatus/list", { threadId, cursor: null, limit: 100, detail: "toolsAndAuthOnly" }) as { data?: readonly unknown[] };
    const names = new Set((value.data ?? []).flatMap((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).name === "string" ? [(item as Record<string, string>).name] : []));
    const missing = connections.map((item) => item.context).filter((name) => !names.has(name));
    if (missing.length) throw new Error(`Codex Context MCP readiness failed; missing required servers: ${missing.join(", ")}`);
  }

  private async memoryToolResult(state: ConnectionState, request: JsonRpcServerRequest): Promise<Record<string, unknown>> {
    if (!this.options.memoryPort) throw new Error("Agent memory service is unavailable");
    const params = isRecord(request.params) ? request.params : {};
    const threadId = typeof params.threadId === "string" ? params.threadId : "";
    const turnId = typeof params.turnId === "string" ? params.turnId : "";
    const namespace = params.namespace;
    const binding = state.memoryBindings.get(threadId);
    if (!binding) throw new Error("Agent memory binding is unavailable");
    const tool = resolveMemoryDynamicTool(binding.toolProfile, namespace, params.tool, params.arguments);
    if (!tool) throw new Error("Unsupported Dynamic Tool");
    const cwd = state.sessionPaths.get(threadId);
    const callId = typeof params.callId === "string" ? params.callId : "";
    if (cwd && turnId && callId) {
      const toolName = typeof namespace === "string" && namespace ? `${namespace}.${String(params.tool ?? tool)}` : String(params.tool ?? tool);
      const decision = this.options.toolCallBudgetRegistry?.observe({ sessionId: threadId, turnId, cwd, toolName, toolUseId: callId });
      if (decision && !decision.allowed) throw new Error(`Tool '${decision.toolName}' reached its per-Turn limit of ${decision.limit} calls`);
    }
    const value = await this.options.memoryPort.call(binding, tool, params.arguments, callId || undefined);
    return {
      contentItems: [{ type: "inputText", text: JSON.stringify(value) }],
      success: true,
    };
  }

  private onClose(state: ConnectionState, socket: WebSocket, code: number, reason: string): void {
    if (state.socket === socket) state.socket = undefined;
    for (const sessionId of state.activeSessions) this.options.hookRegistry?.unregister(sessionId);
    for (const sessionId of state.activeSessions) this.options.toolCallBudgetRegistry?.unregisterSession(sessionId);
    state.activeSessions.clear();
    state.memoryBindings.clear();
    state.sessionPaths.clear();
    const error = new Error(`Codex app-server closed (${code}): ${reason}`);
    for (const [id, pending] of state.pending) {
      state.pending.delete(id);
      clearTimeout(pending.timeout);
      pending.reject(error);
    }
  }

  private async waitForTurn(sandbox: SandboxDescriptor, threadId: string, turnId: string): Promise<Record<string, unknown>> {
    const deadline = Date.now() + this.turnTimeoutMs;
    while (Date.now() < deadline) {
      let response: { thread?: { turns?: readonly Record<string, unknown>[] } };
      try {
        response = await this.request(sandbox, "thread/read", { threadId, includeTurns: true }) as { thread?: { turns?: readonly Record<string, unknown>[] } };
      } catch (error) {
        // `turn/start` can acknowledge before App Server has materialized the
        // first user message into readable thread history. This is a normal
        // startup race, not a failed cognition or an MCP failure.
        if (isThreadMaterializingError(error)) {
          await delay(750);
          continue;
        }
        throw error;
      }
      const turn = response.thread?.turns?.find((item) => item.id === turnId);
      if (turn) {
        if (turn.status === "completed") return turn;
        if (isCompletedTerminalTurn(turn)) {
          if (turn.status === "interrupted" && this.options.toolCallBudgetRegistry?.exhausted(threadId, turnId)) return turn;
          throw new Error(`Codex turn ${String(turn.status)}: ${JSON.stringify(turn.error ?? turn)}`);
        }
      }
      await delay(750);
    }
    throw new Error("Codex turn timed out");
  }

  private async quiesceThread(sandbox: SandboxDescriptor, threadId: string, completedTurnId: string): Promise<void> {
    const deadline = Date.now() + Math.min(this.turnTimeoutMs, 30_000);
    let quietSince: number | undefined;
    while (Date.now() < deadline) {
      const response = await this.request(sandbox, "thread/read", { threadId, includeTurns: true }) as {
        thread?: { turns?: readonly Record<string, unknown>[] };
      };
      const continuationIds = goalContinuationTurnIds(response.thread?.turns ?? [], completedTurnId);
      if (continuationIds.length === 0) {
        quietSince ??= Date.now();
        if (Date.now() - quietSince >= 1_000) return;
        await delay(250);
        continue;
      }
      quietSince = undefined;
      for (const turnId of continuationIds) {
        await this.request(sandbox, "turn/interrupt", { threadId, turnId });
        await this.waitForCompletedTerminalTurn(sandbox, threadId, turnId);
      }
    }
    throw new Error("Codex thread did not become idle after its requested turn");
  }

  private async waitForCompletedTerminalTurn(sandbox: SandboxDescriptor, threadId: string, turnId: string): Promise<void> {
    const deadline = Date.now() + Math.min(this.turnTimeoutMs, 30_000);
    while (Date.now() < deadline) {
      const response = await this.request(sandbox, "thread/read", { threadId, includeTurns: true }) as {
        thread?: { turns?: readonly Record<string, unknown>[] };
      };
      const turn = response.thread?.turns?.find((item) => item.id === turnId);
      if (turn && (turn.status === "completed" || isCompletedTerminalTurn(turn))) return;
      await delay(250);
    }
    throw new Error("Codex goal continuation did not stop");
  }
}

export function goalContinuationTurnIds(
  turns: readonly Record<string, unknown>[],
  completedTurnId: string,
): string[] {
  return turns
    .filter((turn) => turn.id !== completedTurnId && (turn.status === "inProgress" || turn.status === "waitingOnApproval"))
    .map((turn) => turn.id)
    .filter((turnId): turnId is string => typeof turnId === "string" && turnId.length > 0);
}

/**
 * `thread/read` may briefly expose an interrupted placeholder before a newly
 * accepted turn is materialized. Only a terminal snapshot with Codex's
 * completion timestamp is safe to treat as finished; otherwise the authoritative
 * `turn/completed` transition has not happened yet.
 */
export function isCompletedTerminalTurn(turn: Record<string, unknown>): boolean {
  return (turn.status === "failed" || turn.status === "interrupted")
    && typeof turn.completedAt === "number"
    && Number.isFinite(turn.completedAt);
}

export function codexMcpConfig(connections: readonly ContextMcpConnection[]): Record<string, unknown> {
  return {
    mcp_servers: Object.fromEntries(connections.map((connection) => [
      connection.context,
      {
        url: connection.endpoint,
        required: true,
        http_headers: { Authorization: `Bearer ${connection.credential}` },
      },
    ])),
  };
}

interface TurnCollection {
  readonly threadId: string;
  readonly turnId: string;
  readonly pendingItems: Record<string, unknown>[];
  readonly responses: ActionTokenAttribution[];
  turnCounter: TokenUsageBreakdown | null;
  threadCounter: TokenUsageBreakdown | null;
  modelContextWindow: number | null;
  readonly compactions: Array<{ itemId: string; completedAt: string }>;
  readonly events: ProtocolEvent[];
}

export interface ProtocolEvent {
  readonly method: string;
  readonly payload: unknown;
}

/**
 * Notification-only protocol reducer. It is deliberately exported so protocol
 * ordering, interleaving, and missing-usage behavior can be tested without a
 * network connection.
 */
export class TurnTokenCollector {
  private readonly turns = new Map<string, TurnCollection>();

  constructor(private readonly now: () => string = () => new Date().toISOString()) {}

  begin(threadId: string, turnId: string): void {
    this.collection(threadId, turnId);
  }

  accept(method: string, params: unknown): void {
    if (!isRecord(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string") return;
    const collection = this.collection(params.threadId, params.turnId);
    if (method === "rawResponseItem/completed" || method === "rawResponse/completed" || method === "item/completed" || method === "thread/tokenUsage/updated") {
      collection.events.push({ method, payload: structuredClone(params) });
    }
    const completedItem = isRecord(params.item) ? params.item : undefined;
    if (method === "item/completed" && completedItem?.type === "contextCompaction" && typeof completedItem.id === "string") {
      if (!collection.compactions.some((item) => item.itemId === completedItem.id)) {
        collection.compactions.push({ itemId: completedItem.id, completedAt: this.now() });
      }
      return;
    }
    if (method === "rawResponseItem/completed") {
      if (isRecord(params.item)) collection.pendingItems.push(params.item);
      return;
    }
    if (method === "rawResponse/completed") {
      if (typeof params.responseId !== "string") return;
      const toolCalls = collection.pendingItems.flatMap(rawToolCall);
      const usage = tokenBreakdown(params.usage);
      collection.responses.push({
        responseId: params.responseId,
        sequence: collection.responses.length + 1,
        classification: classifyResponse(toolCalls),
        toolCalls,
        usage,
      });
      collection.pendingItems.length = 0;
      return;
    }
    if (method === "thread/tokenUsage/updated" && isRecord(params.tokenUsage)) {
      collection.turnCounter = tokenBreakdown(params.tokenUsage.last);
      collection.threadCounter = tokenBreakdown(params.tokenUsage.total);
      collection.modelContextWindow = typeof params.tokenUsage.modelContextWindow === "number"
        && Number.isFinite(params.tokenUsage.modelContextWindow)
        && params.tokenUsage.modelContextWindow > 0
        ? params.tokenUsage.modelContextWindow
        : null;
    }
  }

  acceptServerExchange(method: string, params: unknown, result: unknown): void {
    if (!isRecord(params) || typeof params.threadId !== "string" || typeof params.turnId !== "string") return;
    this.collection(params.threadId, params.turnId).events.push({
      method: `${method}/completed`,
      payload: { request: structuredClone(params), result: structuredClone(result) },
    });
  }

  finish(threadId: string, turnId: string): AgentTurnTokenUsage {
    return this.finishCapture(threadId, turnId).tokenUsage;
  }

  finishCapture(threadId: string, turnId: string): { readonly tokenUsage: AgentTurnTokenUsage; readonly events: readonly ProtocolEvent[] } {
    const key = turnCollectionKey(threadId, turnId);
    const collection = this.collection(threadId, turnId);
    const responses = collection.responses.map((response) => structuredClone(response));
    const totals = sumUsage(responses.flatMap((response) => response.usage === null ? [] : [response.usage]));
    const missing = responses.length === 0 || responses.some((response) => response.usage === null);
    const batched = responses.some((response) => response.classification === "batched_actions");
    const completeness = missing && batched
      ? "missing_usage_and_batched_actions"
      : missing
        ? "missing_usage"
        : batched
          ? "batched_actions"
          : "complete";
    const result: AgentTurnTokenUsage = {
      threadId,
      turnId,
      responses,
      totals,
      turnCounter: collection.turnCounter === null ? null : structuredClone(collection.turnCounter),
      threadCounter: collection.threadCounter === null ? null : structuredClone(collection.threadCounter),
      modelContextWindow: collection.modelContextWindow,
      compactions: collection.compactions.map((item) => structuredClone(item)),
      countersMatch: collection.turnCounter === null ? null : sameUsage(totals, collection.turnCounter),
      completeness,
    };
    const events = collection.events.map((event) => structuredClone(event));
    this.turns.delete(key);
    return { tokenUsage: result, events };
  }

  private collection(threadId: string, turnId: string): TurnCollection {
    const key = turnCollectionKey(threadId, turnId);
    let collection = this.turns.get(key);
    if (!collection) {
      collection = {
        threadId,
        turnId,
        pendingItems: [],
        responses: [],
        turnCounter: null,
        threadCounter: null,
        modelContextWindow: null,
        compactions: [],
        events: [],
      };
      this.turns.set(key, collection);
    }
    return collection;
  }
}

export function codexThreadInstructionParams(input: {
  readonly baseInstructions: string;
  readonly developerInstructions: string;
  readonly contextCompactionPolicy?: ContextCompactionPolicy;
}): {
  readonly baseInstructions: string;
  readonly developerInstructions: string;
  readonly config: Record<string, boolean | number | string>;
} {
  return {
    baseInstructions: input.baseInstructions,
    developerInstructions: input.developerInstructions,
    config: {
      include_environment_context: false,
      ...(input.contextCompactionPolicy ? {
        model_auto_compact_token_limit: input.contextCompactionPolicy.tokenLimit,
        model_auto_compact_token_limit_scope: input.contextCompactionPolicy.scope,
      } : {}),
    },
  };
}

function connectionKey(sandbox: SandboxDescriptor): string {
  return `${sandbox.containerId ?? "none"}\u0000${sandbox.endpoint}\u0000${sandbox.restartCount}`;
}

function turnText(turn: Record<string, unknown>): string | undefined {
  const items = Array.isArray(turn.items) ? [...turn.items].reverse() : [];
  for (const item of items) {
    if (item && typeof item === "object") {
      const value = item as Record<string, unknown>;
      if (typeof value.text === "string") return value.text;
      if (typeof value.content === "string") return value.content;
    }
  }
  return undefined;
}

function delay(milliseconds: number): Promise<void> { return new Promise((resolve) => setTimeout(resolve, milliseconds)); }

function isResponse(value: unknown): value is JsonRpcResponse {
  return isRecord(value) && (typeof value.id === "string" || typeof value.id === "number") && ("result" in value || "error" in value);
}

function isNotification(value: unknown): value is { readonly method: string; readonly params?: unknown } {
  return isRecord(value) && !("id" in value) && typeof value.method === "string";
}

function isServerRequest(value: unknown): value is JsonRpcServerRequest {
  return isRecord(value) && typeof value.method === "string" && (typeof value.id === "string" || typeof value.id === "number");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function turnCollectionKey(threadId: string, turnId: string): string {
  return `${threadId}\u0000${turnId}`;
}

function rawToolCall(item: Record<string, unknown>): TokenAttributedToolCall[] {
  if (item.type !== "function_call" && item.type !== "custom_tool_call") return [];
  const name = typeof item.name === "string" ? item.name : "";
  const callId = typeof item.call_id === "string" ? item.call_id : "";
  if (!name || !callId) return [];
  return [{
    callId,
    name,
    ...(typeof item.namespace === "string" && item.namespace ? { namespace: item.namespace } : {}),
  }];
}

function classifyResponse(toolCalls: readonly TokenAttributedToolCall[]): ActionTokenAttribution["classification"] {
  if (toolCalls.length === 0) return "final_response";
  if (toolCalls.length === 1) return "mcp_action";
  return "batched_actions";
}

const TOKEN_FIELDS = [
  "totalTokens",
  "inputTokens",
  "cachedInputTokens",
  "cacheWriteInputTokens",
  "outputTokens",
  "reasoningOutputTokens",
] as const;

function tokenBreakdown(value: unknown): TokenUsageBreakdown | null {
  if (!isRecord(value) || TOKEN_FIELDS.some((field) => typeof value[field] !== "number" || !Number.isFinite(value[field]) || value[field] < 0)) return null;
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, value[field]])) as unknown as TokenUsageBreakdown;
}

function sumUsage(values: readonly TokenUsageBreakdown[]): TokenUsageBreakdown {
  return Object.fromEntries(TOKEN_FIELDS.map((field) => [field, values.reduce((sum, value) => sum + value[field], 0)])) as unknown as TokenUsageBreakdown;
}

function sameUsage(left: TokenUsageBreakdown, right: TokenUsageBreakdown): boolean {
  return TOKEN_FIELDS.every((field) => left[field] === right[field]);
}

/** Exported for the protocol-level regression test; no network state is read. */
export function serverRequestResult(request: JsonRpcServerRequest): Record<string, unknown> | undefined {
  switch (request.method) {
    case "item/permissions/requestApproval":
      return permissionApprovalResult(request.params);
    case "item/commandExecution/requestApproval":
    case "item/fileChange/requestApproval":
    case "applyPatchApproval":
    case "execCommandApproval":
      return { decision: "decline" };
    case "mcpServer/elicitation/request":
      return contextMcpElicitationResult(request.params);
    case "item/tool/requestUserInput":
      return { answers: {} };
    default:
      return undefined;
  }
}

function contextMcpElicitationResult(params: unknown): Record<string, unknown> {
  const serverName = isRecord(params) && typeof params.serverName === "string" ? params.serverName : undefined;
  // Only namespaced Context MCP servers can be installed into an Agent
  // workspace. They authenticate with Experiment-issued scoped credentials.
  if (serverName && /^[a-z][a-z0-9_-]{0,239}$/.test(serverName)) {
    return { action: "accept", content: {}, _meta: null };
  }
  return { action: "decline", content: null, _meta: null };
}

function permissionApprovalResult(params: unknown): Record<string, unknown> {
  const permissions = isRecord(params) && isRecord(params.permissions) ? params.permissions : undefined;
  const requestedNetwork = permissions && isRecord(permissions.network) ? permissions.network : undefined;
  // The private mesh has no host route and only carries Context MCP plus the
  // model gateway. Do not echo requested filesystem permissions: the workspace
  // policy already covers the run directory and profile material stays private.
  const network = requestedNetwork?.enabled === true ? { enabled: true } : undefined;
  return {
    permissions: network === undefined ? {} : { network },
    scope: "turn",
  };
}

/** App Server emits this transient error before a first turn is readable. */
export function isThreadMaterializingError(error: unknown): boolean {
  return error instanceof Error && /thread .* is not materialized yet; includeTurns is unavailable before first user message/i.test(error.message);
}
