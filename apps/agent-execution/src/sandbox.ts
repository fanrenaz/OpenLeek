import { posix } from "node:path";
import { rm } from "node:fs/promises";

import type { SandboxDescriptor, SandboxLifecycle } from "./types";
import { runDirectoryName } from "./workspace-artifacts";
import { createRunHookToken } from "./codex-hook";

export interface SandboxEnsureInput {
  readonly runId: string;
  readonly hostRunRoot: string;
  readonly remoteRunRoot: string;
  readonly contexts?: readonly string[];
  readonly existing?: SandboxDescriptor;
  readonly provider?: "deepseek" | "openai";
}

/** The only lifecycle authority for per-run Codex containers. */
export interface SandboxManager {
  ensure(input: SandboxEnsureInput): Promise<SandboxDescriptor>;
  inspect(descriptor: SandboxDescriptor): Promise<SandboxDescriptor>;
  restart(descriptor: SandboxDescriptor): Promise<SandboxDescriptor>;
  release(descriptor: SandboxDescriptor): Promise<SandboxDescriptor>;
}

export interface DockerSandboxConfig {
  /** HTTP endpoint of the Docker Engine socket proxy, not a Docker socket path. */
  readonly socketProxyUrl: string;
  readonly image: string;
  readonly controlNetwork: string;
  readonly contextNetwork: string;
  readonly egressNetwork: string;
  readonly runsHostPath: string;
  readonly runsContainerPath: string;
  readonly appServerToken?: string;
  readonly deepSeekApiKey?: string;
  readonly hookSecret?: string;
  readonly hookEndpoint?: string;
  readonly toolBudgetHookEndpoint?: string;
  readonly appServerPort?: number;
  readonly healthPort?: number;
  readonly readinessTimeoutMs?: number;
  readonly containerPrefix?: string;
}

export interface DockerContainerInfo {
  readonly id: string;
  readonly running: boolean;
  readonly networks: readonly string[];
}

export const CODEX_SANDBOX_SECURITY_OPTIONS = ["apparmor=unconfined", "seccomp=unconfined"] as const;

export interface DockerEngine {
  inspect(container: string): Promise<DockerContainerInfo | null>;
  create(input: {
    readonly name: string;
    readonly image: string;
    readonly networks: readonly string[];
    readonly hostRunRoot: string;
    readonly remoteRunRoot: string;
    readonly codexHomePath: string;
    readonly appServerToken?: string;
    readonly deepSeekApiKey?: string;
    readonly hookToken?: string;
    readonly hookEndpoint?: string;
    readonly toolBudgetHookEndpoint?: string;
  }): Promise<string>;
  start(container: string): Promise<void>;
  restart(container: string): Promise<void>;
  stop(container: string): Promise<void>;
  remove(container: string): Promise<void>;
}

export type SandboxReadinessProbe = (containerName: string, healthPort: number, timeoutMs: number) => Promise<void>;

/**
 * Docker Engine API client deliberately exposes only the narrow lifecycle
 * operations Agent Execution needs. It talks to the configured socket proxy;
 * Agent Execution never shells out to Docker and never owns a global Codex
 * app-server.
 */
export class DockerSocketProxyEngine implements DockerEngine {
  private readonly baseUrl: string;

  constructor(socketProxyUrl: string) {
    this.baseUrl = socketProxyUrl.replace(/\/+$/, "");
  }

  async inspect(container: string): Promise<DockerContainerInfo | null> {
    const response = await this.request(`/containers/${encodeURIComponent(container)}/json`, "GET", undefined, [404]);
    if (response === null) return null;
    const payload = response as { Id?: unknown; State?: { Running?: unknown }; NetworkSettings?: { Networks?: Record<string, unknown> } };
    if (typeof payload.Id !== "string" || !payload.Id) throw new Error("Docker Engine returned an invalid container inspection");
    return { id: payload.Id, running: payload.State?.Running === true, networks: Object.keys(payload.NetworkSettings?.Networks ?? {}).sort() };
  }

  async create(input: Parameters<DockerEngine["create"]>[0]): Promise<string> {
    const env = [
      `HOME=${input.remoteRunRoot}`,
      `CODEX_HOME=${input.codexHomePath}`,
    ];
    if (input.deepSeekApiKey !== undefined) env.push(`DEEPSEEK_API_KEY=${input.deepSeekApiKey}`);
    if (input.appServerToken !== undefined) env.push(`OPENLEEK_SANDBOX_APP_SERVER_TOKEN=${input.appServerToken}`);
    if (input.hookToken !== undefined) env.push(`OPENLEEK_CODEX_HOOK_TOKEN=${input.hookToken}`);
    if (input.hookEndpoint !== undefined) env.push(`OPENLEEK_CODEX_HOOK_URL=${input.hookEndpoint}`);
    if (input.toolBudgetHookEndpoint !== undefined) env.push(`OPENLEEK_CODEX_TOOL_BUDGET_HOOK_URL=${input.toolBudgetHookEndpoint}`);
    const payload = await this.request(`/containers/create?name=${encodeURIComponent(input.name)}`, "POST", {
      Image: input.image,
      Env: env,
      Labels: { "openleek.agent-execution": "run-sandbox" },
      HostConfig: {
        Binds: [`${input.hostRunRoot}:${input.remoteRunRoot}:rw`],
        SecurityOpt: [...CODEX_SANDBOX_SECURITY_OPTIONS],
      },
      NetworkingConfig: {
        EndpointsConfig: Object.fromEntries(input.networks.map((network) => [network, { Aliases: [input.name] }])),
      },
    });
    const id = (payload as { Id?: unknown }).Id;
    if (typeof id !== "string" || !id) throw new Error("Docker Engine did not return a container id");
    return id;
  }

  async start(container: string): Promise<void> { await this.request(`/containers/${encodeURIComponent(container)}/start`, "POST"); }
  async restart(container: string): Promise<void> { await this.request(`/containers/${encodeURIComponent(container)}/restart?t=10`, "POST"); }
  async stop(container: string): Promise<void> { await this.request(`/containers/${encodeURIComponent(container)}/stop?t=10`, "POST", undefined, [304, 404]); }
  async remove(container: string): Promise<void> { await this.request(`/containers/${encodeURIComponent(container)}?force=true`, "DELETE", undefined, [404]); }

  private async request(path: string, method: string, body?: unknown, allowedStatuses: readonly number[] = []): Promise<unknown | null> {
    const response = await fetch(`${this.baseUrl}${path}`, {
      method,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
    if (allowedStatuses.includes(response.status)) return null;
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 512);
      throw new Error(`Docker Engine ${method} ${path} failed (${response.status})${detail ? `: ${detail}` : ""}`);
    }
    if (response.status === 204 || response.headers.get("content-length") === "0") return {};
    const text = await response.text();
    return text ? JSON.parse(text) : {};
  }
}

/** Docker-backed implementation used by the deployed runtime. */
export class DockerSandboxManager implements SandboxManager {
  private readonly port: number;
  private readonly healthPort: number;
  private readonly readinessTimeoutMs: number;
  private readonly prefix: string;

  constructor(
    private readonly config: DockerSandboxConfig,
    private readonly engine: DockerEngine = new DockerSocketProxyEngine(config.socketProxyUrl),
    private readonly waitForReady: SandboxReadinessProbe = waitForSandboxReady,
  ) {
    this.port = config.appServerPort ?? 4500;
    this.healthPort = config.healthPort ?? 4501;
    this.readinessTimeoutMs = config.readinessTimeoutMs ?? 30_000;
    this.prefix = config.containerPrefix ?? "openleek-agent";
    if (!config.image.trim() || !config.controlNetwork.trim() || !config.egressNetwork.trim() || !config.runsHostPath.trim() || !config.runsContainerPath.trim()) {
      throw new Error("sandbox image, networks, and run paths must be configured");
    }
    if (!config.contextNetwork.trim() || config.controlNetwork === config.egressNetwork || config.contextNetwork === config.controlNetwork || config.contextNetwork === config.egressNetwork) {
      throw new Error("sandbox control, Context Gateway, and egress networks must be distinct and non-empty");
    }
    if (!Number.isInteger(this.port) || this.port < 1 || this.port > 65_535) throw new Error("sandbox app-server port must be valid");
    if (!Number.isInteger(this.healthPort) || this.healthPort < 1 || this.healthPort > 65_535) throw new Error("sandbox health port must be valid");
  }

  async ensure(input: SandboxEnsureInput): Promise<SandboxDescriptor> {
    this.assertRunRoots(input);
    const networks = this.networks();
    const existing = input.existing;
    if (existing !== undefined) this.assertDescriptorName(existing);
    if (existing?.lifecycle !== "released" && existing?.containerId) {
      const inspected = await this.engine.inspect(existing.containerId);
      if (inspected && !sameNetworks(inspected.networks, networks)) {
        await this.engine.stop(inspected.id);
        await this.engine.remove(inspected.id);
      } else if (inspected?.running) {
        // A Docker-level restart can report running before the wrapper has
        // reopened Codex. Check the run-specific endpoint before a turn.
        await this.waitForReady(existing.containerName, this.healthPort, this.readinessTimeoutMs);
        return this.describe(input, existing, inspected.id, "running", existing.restartCount, networks);
      }
      if (inspected && sameNetworks(inspected.networks, networks)) {
        await this.engine.start(inspected.id);
        await this.waitForReady(existing.containerName, this.healthPort, this.readinessTimeoutMs);
        return this.describe(input, existing, inspected.id, "running", existing.restartCount + 1, networks);
      }
    }
    const name = existing?.containerName || this.containerName(input.runId);
    // Recover the small window between Docker create and state persistence.
    // The deterministic name is derived only from the opaque run hash.
    const named = await this.engine.inspect(name);
    if (named && !sameNetworks(named.networks, networks)) {
      await this.engine.stop(named.id);
      await this.engine.remove(named.id);
    } else if (named?.running) {
      await this.waitForReady(name, this.healthPort, this.readinessTimeoutMs);
      return this.describe(input, existing, named.id, "running", existing?.restartCount ?? 0, networks);
    }
    if (named && sameNetworks(named.networks, networks)) {
      await this.engine.start(named.id);
      await this.waitForReady(name, this.healthPort, this.readinessTimeoutMs);
      return this.describe(input, existing, named.id, "running", (existing?.restartCount ?? -1) + 1, networks);
    }
    const codexHomePath = posix.join(input.remoteRunRoot, "codex-home");
    const containerId = await this.engine.create({
      name,
      image: this.config.image,
      networks,
      hostRunRoot: input.hostRunRoot,
      remoteRunRoot: input.remoteRunRoot,
      codexHomePath,
      ...(input.provider === "openai" ? {} : { deepSeekApiKey: this.requireDeepSeekKey() }),
      ...(this.config.appServerToken === undefined ? {} : { appServerToken: this.config.appServerToken }),
      ...(this.config.hookSecret === undefined ? {} : { hookToken: createRunHookToken(this.config.hookSecret, input.runId) }),
      ...(this.config.hookEndpoint === undefined ? {} : { hookEndpoint: this.config.hookEndpoint }),
      ...(this.config.toolBudgetHookEndpoint === undefined ? {} : { toolBudgetHookEndpoint: this.config.toolBudgetHookEndpoint }),
    });
    await this.engine.start(containerId);
    await this.waitForReady(name, this.healthPort, this.readinessTimeoutMs);
    return this.describe(input, existing, containerId, "running", (existing?.restartCount ?? -1) + 1, networks);
  }

  private requireDeepSeekKey(): string {
    if (!this.config.deepSeekApiKey) throw new Error("DEEPSEEK_API_KEY is required for a DeepSeek Run");
    return this.config.deepSeekApiKey;
  }

  async inspect(descriptor: SandboxDescriptor): Promise<SandboxDescriptor> {
    if (descriptor.lifecycle === "released" || !descriptor.containerId) return descriptor;
    const container = await this.engine.inspect(descriptor.containerId);
    if (container === null) return { ...descriptor, lifecycle: "stopped", updatedAt: now() };
    return { ...descriptor, containerId: container.id, lifecycle: container.running ? "running" : "stopped", updatedAt: now() };
  }

  async restart(descriptor: SandboxDescriptor): Promise<SandboxDescriptor> {
    this.assertDescriptorName(descriptor);
    if (descriptor.lifecycle === "released" || !descriptor.containerId) {
      return this.ensure({ runId: descriptor.runId, hostRunRoot: descriptor.hostRunRoot, remoteRunRoot: descriptor.remoteRunRoot, existing: descriptor });
    }
    const container = await this.engine.inspect(descriptor.containerId);
    if (container === null) {
      return this.ensure({ runId: descriptor.runId, hostRunRoot: descriptor.hostRunRoot, remoteRunRoot: descriptor.remoteRunRoot, existing: descriptor });
    }
    await this.engine.restart(container.id);
    await this.waitForReady(descriptor.containerName, this.healthPort, this.readinessTimeoutMs);
    return { ...descriptor, containerId: container.id, lifecycle: "running", restartCount: descriptor.restartCount + 1, updatedAt: now() };
  }

  async release(descriptor: SandboxDescriptor): Promise<SandboxDescriptor> {
    if (descriptor.lifecycle === "released") return descriptor;
    this.assertDescriptorName(descriptor);
    this.assertRunRoots({
      runId: descriptor.runId,
      hostRunRoot: descriptor.hostRunRoot,
      remoteRunRoot: descriptor.remoteRunRoot,
    });
    if (descriptor.containerId) {
      await this.engine.stop(descriptor.containerId);
      await this.engine.remove(descriptor.containerId);
    }
    // Exact run-root validation above prevents an untrusted descriptor from
    // broadening this deletion to the shared runs directory. Agent Execution
    // sees the bind through runsContainerPath; hostRunRoot is meaningful only
    // to the Docker daemon and may not exist inside this service container.
    await rm(descriptor.remoteRunRoot, { recursive: true, force: true, maxRetries: 2 });
    const releasedAt = now();
    return { ...descriptor, lifecycle: "released", updatedAt: releasedAt, releasedAt };
  }

  private describe(input: SandboxEnsureInput, existing: SandboxDescriptor | undefined, containerId: string, lifecycle: SandboxLifecycle, restartCount: number, networks: readonly string[]): SandboxDescriptor {
    const updatedAt = now();
    return {
      runId: input.runId,
      containerId,
      containerName: existing?.containerName || this.containerName(input.runId),
      endpoint: `ws://${existing?.containerName || this.containerName(input.runId)}:${this.port}`,
      hostRunRoot: input.hostRunRoot,
      remoteRunRoot: input.remoteRunRoot,
      codexHomePath: posix.join(input.remoteRunRoot, "codex-home"),
      networks,
      lifecycle,
      restartCount,
      createdAt: existing?.createdAt ?? updatedAt,
      updatedAt,
    };
  }

  private networks(): readonly string[] {
    return [this.config.controlNetwork, this.config.contextNetwork, this.config.egressNetwork].sort();
  }

  private containerName(runId: string): string { return `${this.prefix}-${runDirectoryName(runId).slice(0, 32)}`; }

  private assertDescriptorName(descriptor: SandboxDescriptor): void {
    if (descriptor.containerName !== this.containerName(descriptor.runId)) {
      throw new Error("sandbox descriptor container name is not derived from its run id");
    }
  }

  private assertRunRoots(input: SandboxEnsureInput): void {
    const runHash = runDirectoryName(input.runId);
    const expectedHost = `${this.config.runsHostPath.replace(/\/+$/, "")}/${runHash}`;
    const expectedRemote = posix.join(this.config.runsContainerPath, runHash);
    if (input.hostRunRoot !== expectedHost || input.remoteRunRoot !== expectedRemote) {
      throw new Error("sandbox run roots must be derived from the configured host and container run roots");
    }
  }
}

async function waitForSandboxReady(containerName: string, healthPort: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let lastError = "health endpoint did not respond";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://${containerName}:${healthPort}/health`, { signal: AbortSignal.timeout(Math.min(2_000, timeoutMs)) });
      if (response.ok) return;
      lastError = `health endpoint returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`sandbox '${containerName}' did not become ready: ${lastError}`);
}

/** Keeps unit/in-memory operation deterministic without ever creating Docker state. */
export class InMemorySandboxManager implements SandboxManager {
  async ensure(input: SandboxEnsureInput): Promise<SandboxDescriptor> {
    const existing = input.existing;
    const timestamp = now();
    return {
      runId: input.runId,
      containerId: null,
      containerName: `in-memory-${runDirectoryName(input.runId).slice(0, 16)}`,
      endpoint: "ws://in-memory.invalid",
      hostRunRoot: input.hostRunRoot,
      remoteRunRoot: input.remoteRunRoot,
      codexHomePath: posix.join(input.remoteRunRoot, "codex-home"),
      networks: [],
      lifecycle: "running",
      restartCount: existing ? existing.restartCount + (existing.lifecycle === "running" ? 0 : 1) : 0,
      createdAt: existing?.createdAt ?? timestamp,
      updatedAt: timestamp,
    };
  }

  async inspect(descriptor: SandboxDescriptor): Promise<SandboxDescriptor> { return descriptor; }
  async restart(descriptor: SandboxDescriptor): Promise<SandboxDescriptor> {
    return { ...descriptor, lifecycle: "running", restartCount: descriptor.restartCount + 1, updatedAt: now() };
  }
  async release(descriptor: SandboxDescriptor): Promise<SandboxDescriptor> {
    if (descriptor.lifecycle === "released") return descriptor;
    const releasedAt = now();
    return { ...descriptor, lifecycle: "released", updatedAt: releasedAt, releasedAt };
  }
}

function now(): string { return new Date().toISOString(); }

function sameNetworks(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && [...left].sort().every((network, index) => network === [...right].sort()[index]);
}
