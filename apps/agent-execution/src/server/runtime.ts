import { Pool } from "pg";

import { CodexAgentBackend, type CodexTurnClient } from "../backends/codex";
import { CodexAppServerTurnClient } from "../backends/codex-app-server";
import type { AgentExecutionBackend, AgentExecutionStateStore, SqlExecutor } from "../ports";
import { HttpHindsightMemoryClient, type MemoryToolPort } from "../memory-tools";
import { createAgentExecutionRouter } from "../router";
import { DockerSandboxManager, type SandboxManager } from "../sandbox";
import { AgentExecutionService } from "../service";
import {
  InMemoryAgentExecutionStateStore,
  PostgresAgentExecutionStateStore,
} from "../state-store";
import type { AgentExecutionRuntimeCapability } from "../types";
import {
  buildCodexHookContext,
  CodexHookRegistry,
  type CodexHookContextResult,
  type CodexHookRequest,
  verifyRunHookToken,
} from "../codex-hook";
import { emitObservabilityLog, SeverityNumber } from "@openleek/observability";
import { ToolCallBudgetRegistry, type ToolCallBudgetDecision, type ToolCallBudgetRequest } from "../tool-call-budget";
import { ChatGptAuthClient } from "../chatgpt-auth";

type Environment = Readonly<Record<string, string | undefined>>;

export interface AgentExecutionRuntime {
  readonly service: AgentExecutionService;
  readonly router: ReturnType<typeof createAgentExecutionRouter>;
  readonly backend: AgentExecutionBackend;
  readonly capability?: AgentExecutionRuntimeCapability;
  codexHookContext(authorization: string | null, input: CodexHookRequest): Promise<CodexHookContextResult>;
  codexToolCallBudget(authorization: string | null, input: ToolCallBudgetRequest): Promise<ToolCallBudgetDecision>;
  ready(): Promise<void>;
  close(): Promise<void>;
}

export interface AgentExecutionRuntimeDependencies {
  readonly stateStore?: AgentExecutionStateStore;
  readonly backend?: AgentExecutionBackend;
  readonly createCodexTurnClient?: (environment: Environment) => Promise<CodexTurnClient>;
  readonly sandboxManager?: SandboxManager;
  /** Test-only capability override. Production uses the fixed DeepSeek profile. */
  readonly runtimeCapability?: AgentExecutionRuntimeCapability;
  readonly memoryPort?: MemoryToolPort;
}

/**
 * Builds the Codex-only research runtime in isolation. Unit tests may inject a
 * Codex backend double around a private port; production has no deployment or
 * public-network selector for another backend.
 */
export async function createAgentExecutionRuntime(
  environment: Environment = process.env,
  dependencies: AgentExecutionRuntimeDependencies = {},
): Promise<AgentExecutionRuntime> {
  const store = dependencies.stateStore ?? await stateStoreFromEnvironment(environment);
  rejectLegacyBackendSelector(environment);
  rejectGlobalAppServerConfiguration(environment);
  const memoryPort = dependencies.memoryPort ?? memoryPortFromEnvironment(environment);
  const hookRegistry = new CodexHookRegistry();
  const toolCallBudgetRegistry = new ToolCallBudgetRegistry();
  const chatGptAuth = chatGptAuthFromEnvironment(environment);
  const hookSecret = optional(environment, "OPENLEEK_SANDBOX_HOOK_SECRET");
  const sandbox = sandboxFromEnvironment(environment, dependencies.sandboxManager);
  const configuredSandboxMode = sandboxMode(environment);
  const backend = dependencies.backend ?? await backendFromEnvironment(environment, dependencies, memoryPort, hookRegistry, toolCallBudgetRegistry);
  if (backend.name !== "codex") throw new Error("Agent Execution runtime only accepts Codex");
  const service = await AgentExecutionService.open(
    backend,
    store,
    {
      ...(dependencies.runtimeCapability === undefined ? {} : { runtimeCapability: dependencies.runtimeCapability }),
      ...(sandbox.workspaceRoot === undefined ? {} : { workspaceRoot: sandbox.workspaceRoot }),
      ...(sandbox.sandboxRunsRoot === undefined ? {} : { sandboxRunsRoot: sandbox.sandboxRunsRoot }),
      ...(sandbox.sandboxHostRunsRoot === undefined ? {} : { sandboxHostRunsRoot: sandbox.sandboxHostRunsRoot }),
      sandboxMode: configuredSandboxMode,
      sandboxManager: sandbox.manager,
      ...(memoryPort ? { memoryPort } : {}),
      ...(chatGptAuth ? { chatGptAuth } : {}),
    },
  );
  return {
    service,
    router: createAgentExecutionRouter(service),
    backend,
    capability: service.runtimeCapability(),
    async codexHookContext(authorization, input) {
      const startedAt = Date.now();
      const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
      const binding = hookRegistry.resolve(input.sessionId, input.cwd);
      if (!hookSecret || !memoryPort || !binding || !verifyRunHookToken(hookSecret, binding.runId, token)) {
        throw new Error("invalid_hook_token");
      }
      const policy = service.getHookPolicy(binding.runId);
      if (!policy.strategyInjectionEnabled) {
        return { additionalContext: "", strategyIncluded: false, errorCategories: [] };
      }
      const result = await buildCodexHookContext(memoryPort, binding.memory, policy);
      emitObservabilityLog("codex_hook.user_prompt_submit", {
        runId: binding.runId,
        turnId: input.turnId,
        policyRevision: policy.revision,
        strategyIncluded: result.strategyIncluded,
        contextCharacters: result.additionalContext.length,
        durationMs: Date.now() - startedAt,
        errorCategories: result.errorCategories.join(","),
      }, result.errorCategories.length ? SeverityNumber.WARN : SeverityNumber.INFO);
      return result;
    },
    async codexToolCallBudget(authorization, input) {
      const token = authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : "";
      const binding = toolCallBudgetRegistry.resolve(input.sessionId, input.cwd);
      if (!hookSecret || !binding || !verifyRunHookToken(hookSecret, binding.runId, token)) throw new Error("invalid_hook_token");
      return toolCallBudgetRegistry.authorize(input);
    },
    async ready() {
      await service.health();
    },
    async close() {
      if (store instanceof OwnedPostgresStateStore) await store.close();
    },
  };
}

let currentRuntime: Promise<AgentExecutionRuntime> | undefined;

/** Process-local Next runtime singleton; persistence remains Postgres-owned. */
export function agentExecutionRuntime(): Promise<AgentExecutionRuntime> {
  currentRuntime ??= createAgentExecutionRuntime();
  return currentRuntime;
}

async function backendFromEnvironment(
  environment: Environment,
  dependencies: AgentExecutionRuntimeDependencies,
  memoryPort: MemoryToolPort | undefined,
  hookRegistry: CodexHookRegistry,
  toolCallBudgetRegistry: ToolCallBudgetRegistry,
): Promise<AgentExecutionBackend> {
  const client = dependencies.createCodexTurnClient === undefined
    ? await loadCodexTurnClient(environment, memoryPort, hookRegistry, toolCallBudgetRegistry)
    : await dependencies.createCodexTurnClient(environment);
  return new CodexAgentBackend(client);
}

function rejectLegacyBackendSelector(environment: Environment): void {
  const configured = optional(environment, "OPENLEEK_AGENT_EXECUTION_BACKEND");
  if (configured !== undefined && configured !== "codex") {
    throw new Error("OPENLEEK_AGENT_EXECUTION_BACKEND is no longer supported; research runs always use Codex");
  }
}

function rejectGlobalAppServerConfiguration(environment: Environment): void {
  const legacy = [
    "OPENLEEK_CODEX_APP_SERVER_URL",
    "OPENLEEK_CODEX_APP_SERVER_WORKSPACE_ROOT",
    "OPENLEEK_WORKSPACE_ROOT",
    "OPENLEEK_CODEX_WS_TOKEN",
    "OPENLEEK_AGENT_EXECUTION_MODEL",
  ].find((name) => optional(environment, name) !== undefined);
  if (legacy !== undefined) {
    throw new Error(`${legacy} configures the removed global Codex app-server; use per-run OPENLEEK_SANDBOX_* configuration`);
  }
  const marker = optional(environment, "OPENLEEK_AGENT_EXECUTION_DEPLOYMENT_MARKER");
  if (marker !== undefined && marker !== "per-run-sandbox-v1") {
    throw new Error("OPENLEEK_AGENT_EXECUTION_DEPLOYMENT_MARKER must be per-run-sandbox-v1");
  }
}

async function stateStoreFromEnvironment(environment: Environment): Promise<AgentExecutionStateStore> {
  if (environment.OPENLEEK_AGENT_EXECUTION_IN_MEMORY === "true") {
    return new InMemoryAgentExecutionStateStore();
  }
  const dsn = environment.OPENLEEK_AGENT_EXECUTION_DATABASE_URL
    ?? environment.OPENLEEK_AGENT_EXECUTION_POSTGRES_DSN;
  if (!dsn) {
    throw new Error("OPENLEEK_AGENT_EXECUTION_DATABASE_URL is required");
  }
  return new OwnedPostgresStateStore(dsn);
}

/** The default routes every call through the selected per-run sandbox. */
async function loadCodexTurnClient(environment: Environment, memoryPort: MemoryToolPort | undefined, hookRegistry: CodexHookRegistry, toolCallBudgetRegistry: ToolCallBudgetRegistry): Promise<CodexTurnClient> {
  const moduleSpecifier = optional(environment, "OPENLEEK_CODEX_TURN_CLIENT_MODULE");
  if (moduleSpecifier === undefined) {
    const token = optional(environment, "OPENLEEK_SANDBOX_APP_SERVER_TOKEN");
    const chatGptAuth = chatGptAuthFromEnvironment(environment);
    return new CodexAppServerTurnClient({
      ...(token === undefined ? {} : { token }),
      sandboxMode: sandboxMode(environment),
      turnTimeoutMs: positiveInteger(environment.OPENLEEK_AGENT_EXECUTION_TURN_TIMEOUT_MS, 30 * 60 * 1_000),
      ...(memoryPort ? { memoryPort } : {}),
      hookRegistry,
      toolCallBudgetRegistry,
      ...(chatGptAuth ? { chatGptAuth } : {}),
    });
  }
  const loaded = await dynamicImport(moduleSpecifier) as {
    createCodexTurnClient?: (environment: Environment) => Promise<unknown> | unknown;
    default?: ((environment: Environment) => Promise<unknown> | unknown) | unknown;
  };
  const factory = loaded.createCodexTurnClient
    ?? (typeof loaded.default === "function" ? loaded.default as (environment: Environment) => Promise<unknown> | unknown : undefined);
  if (factory === undefined) {
    throw new Error("Codex turn-client module must export createCodexTurnClient(environment)");
  }
  const client = await factory(environment);
  if (!isCodexTurnClient(client)) {
    throw new Error("Codex turn-client module returned an invalid client");
  }
  return client;
}

function memoryPortFromEnvironment(environment: Environment): MemoryToolPort | undefined {
  const baseUrl = optional(environment, "OPENLEEK_HINDSIGHT_URL");
  return baseUrl ? new HttpHindsightMemoryClient({ baseUrl }) : undefined;
}

function sandboxFromEnvironment(
  environment: Environment,
  injected: SandboxManager | undefined,
): {
  readonly manager: SandboxManager;
  readonly workspaceRoot?: string;
  readonly sandboxRunsRoot?: string;
  readonly sandboxHostRunsRoot?: string;
} {
  const runsHostPath = optional(environment, "OPENLEEK_SANDBOX_RUNS_HOST_PATH");
  const sandboxRunsRoot = optional(environment, "OPENLEEK_SANDBOX_RUNS_CONTAINER_PATH") ?? "/var/lib/openleek/runs";
  if (injected !== undefined) {
    return {
      manager: injected,
      ...(runsHostPath === undefined ? {} : { workspaceRoot: sandboxRunsRoot }),
      ...(runsHostPath === undefined ? {} : { sandboxRunsRoot }),
      ...(runsHostPath === undefined ? {} : { sandboxHostRunsRoot: runsHostPath }),
    };
  }
  if (runsHostPath === undefined || !runsHostPath.startsWith("/")) {
    throw new Error("OPENLEEK_SANDBOX_RUNS_HOST_PATH must be an absolute host path");
  }
  const socketProxyUrl = dockerSocketProxyUrl(environment);
  const image = required(environment, "OPENLEEK_SANDBOX_IMAGE");
  const controlNetwork = required(environment, "OPENLEEK_SANDBOX_CONTROL_NETWORK");
  const contextNetwork = required(environment, "OPENLEEK_SANDBOX_CONTEXT_NETWORK");
  const egressNetwork = required(environment, "OPENLEEK_SANDBOX_EGRESS_NETWORK");
  const deepSeekApiKey = optional(environment, "DEEPSEEK_API_KEY");
  const appServerToken = optional(environment, "OPENLEEK_SANDBOX_APP_SERVER_TOKEN");
  const hookSecret = required(environment, "OPENLEEK_SANDBOX_HOOK_SECRET");
  if (hookSecret.length < 32) throw new Error("OPENLEEK_SANDBOX_HOOK_SECRET must contain at least 32 characters");
  const hookEndpoint = optional(environment, "OPENLEEK_SANDBOX_HOOK_URL")
    ?? "http://agent-execution:3000/api/internal/codex-hooks/user-prompt-submit";
  const toolBudgetHookEndpoint = optional(environment, "OPENLEEK_SANDBOX_TOOL_BUDGET_HOOK_URL")
    ?? "http://agent-execution:3000/api/internal/codex-hooks/pre-tool-use";
  return {
    manager: new DockerSandboxManager({
      socketProxyUrl,
      image,
      controlNetwork,
      contextNetwork,
      egressNetwork,
      ...(deepSeekApiKey ? { deepSeekApiKey } : {}),
      runsHostPath,
      runsContainerPath: sandboxRunsRoot,
      ...(appServerToken === undefined ? {} : { appServerToken }),
      hookSecret,
      hookEndpoint,
      toolBudgetHookEndpoint,
      appServerPort: positiveInteger(environment.OPENLEEK_SANDBOX_APP_SERVER_PORT, 4500),
      healthPort: positiveInteger(environment.OPENLEEK_SANDBOX_HEALTH_PORT, 4501),
      readinessTimeoutMs: positiveInteger(environment.OPENLEEK_SANDBOX_READINESS_TIMEOUT_MS, 30_000),
    }),
    // Agent Execution writes through its own bind mount, never through the
    // host path that Docker receives when creating a sandbox container.
    workspaceRoot: sandboxRunsRoot,
    sandboxRunsRoot,
    sandboxHostRunsRoot: runsHostPath,
  };
}

function chatGptAuthFromEnvironment(environment: Environment): ChatGptAuthClient | undefined {
  const url = optional(environment, "OPENLEEK_CHATGPT_AUTH_BROKER_URL");
  const token = optional(environment, "OPENLEEK_CHATGPT_AUTH_BROKER_TOKEN");
  if (url === undefined && token === undefined) return undefined;
  if (!url || !token) throw new Error("OPENLEEK_CHATGPT_AUTH_BROKER_URL and OPENLEEK_CHATGPT_AUTH_BROKER_TOKEN must be configured together");
  return new ChatGptAuthClient(url, token);
}

function dockerSocketProxyUrl(environment: Environment): string {
  const raw = optional(environment, "OPENLEEK_DOCKER_SOCKET_PROXY_URL")
    ?? optional(environment, "OPENLEEK_SANDBOX_SOCKET_PROXY_URL")
    ?? optional(environment, "DOCKER_HOST");
  if (raw === undefined) throw new Error("OPENLEEK_DOCKER_SOCKET_PROXY_URL or DOCKER_HOST is required for per-run sandboxes");
  const normalized = raw.startsWith("tcp://") ? `http://${raw.slice("tcp://".length)}` : raw;
  try {
    const url = new URL(normalized);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("unsupported protocol");
    return url.toString().replace(/\/$/, "");
  } catch {
    throw new Error("Docker socket proxy must use an http(s) URL");
  }
}

function required(environment: Environment, name: string): string {
  const value = optional(environment, name);
  if (value === undefined) throw new Error(`${name} is required for per-run sandboxes`);
  return value;
}

function isCodexTurnClient(value: unknown): value is CodexTurnClient {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return typeof candidate.startSession === "function"
    && typeof candidate.resumeSession === "function"
    && typeof candidate.runTurn === "function";
}

function optional(environment: Environment, name: string): string | undefined {
  const value = environment[name]?.trim();
  return value ? value : undefined;
}

function sandboxMode(environment: Environment): "workspace-write" | "danger-full-access" {
  const mode = optional(environment, "OPENLEEK_CODEX_SANDBOX_MODE") ?? "danger-full-access";
  if (mode === "workspace-write" || mode === "danger-full-access") return mode;
  throw new Error("OPENLEEK_CODEX_SANDBOX_MODE must be 'workspace-write' or 'danger-full-access'");
}

function positiveInteger(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    throw new Error("configured sandbox/runtime timeout must be a positive integer");
  }
  return value;
}

async function dynamicImport(specifier: string): Promise<unknown> {
  // Keep an optional adapter from becoming a webpack context dependency in the
  // standalone default Codex image.
  return new Function("moduleSpecifier", "return import(moduleSpecifier)")(specifier) as Promise<unknown>;
}

class OwnedPostgresStateStore extends PostgresAgentExecutionStateStore {
  private readonly pool: Pool;

  constructor(dsn: string) {
    const pool = new Pool({ connectionString: dsn });
    super(new PgExecutor(pool));
    this.pool = pool;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }
}

class PgExecutor implements SqlExecutor {
  constructor(private readonly pool: Pool) {}

  async query<T extends Record<string, unknown> = Record<string, unknown>>(
    sql: string,
    values: readonly unknown[] = [],
  ): Promise<{ readonly rows: readonly T[] }> {
    const result = await this.pool.query<T>(sql, [...values]);
    return { rows: result.rows };
  }

  async transaction<T>(operation: (executor: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    try {
      await client.query("begin");
      const executor: SqlExecutor = {
        query: async <R extends Record<string, unknown> = Record<string, unknown>>(sql: string, values: readonly unknown[] = []) => {
          const result = await client.query<R>(sql, [...values]);
          return { rows: result.rows };
        },
      };
      const value = await operation(executor);
      await client.query("commit");
      return value;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
}
